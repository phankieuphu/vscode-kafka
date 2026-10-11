import * as assert from 'assert';
import * as vscode from 'vscode';
import { ClusterManager, INTERNAL_GROUP_PREFIX } from '../kafka/clusterManager';
import { ClusterConfig } from '../kafka/types';

type Watermark = { partition: number; low: string; high: string };

/** Delivers offsets [from, high) of each seeked partition as one batch. */
class FakeConsumer {
	runOptions: { autoCommit?: boolean; eachBatch?: (p: unknown) => Promise<void>; eachMessage?: (p: unknown) => Promise<void> } | undefined;
	disconnects = 0;
	readonly events = { CRASH: 'consumer.crash' };

	constructor(readonly groupId: string, private readonly marks: Watermark[]) {}

	async connect() {}
	async subscribe() {}
	on() {}
	async run(options: FakeConsumer['runOptions']) {
		this.runOptions = options;
	}
	seek({ partition, offset }: { partition: number; offset: string }) {
		const high = Number(this.marks.find((m) => m.partition === partition)!.high);
		const messages: Array<{ offset: string; key: Buffer; value: Buffer; timestamp: string; headers: object }> = [];
		for (let o = Number(offset); o < high; o++) {
			messages.push({ offset: String(o), key: Buffer.from(`k${o}`), value: Buffer.from(o % 2 ? 'odd' : 'even'), timestamp: String(1000 + o), headers: {} });
		}
		setImmediate(() => void this.runOptions?.eachBatch?.({
			batch: { partition, messages, lastOffset: () => String(high - 1) },
		}));
	}
	async disconnect() {
		this.disconnects++;
	}
}

class FakeAdmin {
	deletedGroups: string[][] = [];
	disconnects = 0;
	constructor(private readonly marks: Watermark[]) {}
	async connect() {}
	async listTopics() { return ['orders']; }
	async fetchTopicOffsets() { return this.marks; }
	async fetchTopicMetadata({ topics }: { topics?: string[] } = {}) {
		return { topics: (topics ?? ['orders']).filter((t) => t === 'orders').map((name) => ({ name, partitions: [] })) };
	}
	async listGroups() {
		return { groups: [{ groupId: 'billing', protocolType: 'consumer' }, { groupId: `${INTERNAL_GROUP_PREFIX}history-old`, protocolType: 'consumer' }] };
	}
	async deleteGroups(ids: string[]) { this.deletedGroups.push(ids); }
	async disconnect() { this.disconnects++; }
}

class FakeProducer {
	sent: unknown[] = [];
	connects = 0;
	disconnects = 0;
	async connect() { this.connects++; }
	async send(record: unknown) { this.sent.push(record); }
	async disconnect() { this.disconnects++; }
}

suite('ClusterManager with a fake broker', () => {
	const cluster: ClusterConfig = { id: 'fake', name: 'Fake', brokers: ['localhost:1'] };
	const marks: Watermark[] = [{ partition: 0, low: '0', high: '10' }, { partition: 1, low: '5', high: '8' }];
	let manager: ClusterManager;
	let admin: FakeAdmin;
	let consumers: FakeConsumer[];
	let producers: FakeProducer[];

	setup(async () => {
		manager = new ClusterManager();
		consumers = [];
		producers = [];
		(manager as unknown as { kafkaInstances: Map<string, unknown> }).kafkaInstances.set(cluster.id, {
			admin: () => (admin = new FakeAdmin(marks)),
			consumer: ({ groupId }: { groupId: string }) => {
				const c = new FakeConsumer(groupId, marks);
				consumers.push(c);
				return c;
			},
			producer: () => {
				const p = new FakeProducer();
				producers.push(p);
				return p;
			},
		});
		await manager.connect(cluster);
	});

	teardown(() => manager.dispose());

	test('browsing never commits, and deletes its throwaway group afterwards (#11)', async () => {
		const messages = await manager.loadRecentMessages(cluster, 'orders', 3);

		assert.deepStrictEqual(messages.map((m) => `${m.partition}:${m.offset}`), ['0:7', '0:8', '0:9', '1:5', '1:6', '1:7']);
		assert.strictEqual(consumers[0].runOptions?.autoCommit, false);
		assert.strictEqual(consumers[0].disconnects, 1);
		assert.ok(consumers[0].groupId.startsWith(INTERNAL_GROUP_PREFIX));
		await new Promise((r) => setImmediate(r));
		assert.deepStrictEqual(admin.deletedGroups, [[consumers[0].groupId]]);
	});

	test('internal groups are hidden from the group list (#11)', async () => {
		assert.deepStrictEqual((await manager.listConsumerGroups(cluster)).map((g) => g.groupId), ['billing']);
	});

	test('searching keeps only matches and reports what it scanned (#19)', async () => {
		const result = await manager.browse(cluster, 'orders', {
			position: { kind: 'oldest' }, limit: 100, search: 'odd', partition: 0, scanLimit: 100,
		});
		assert.deepStrictEqual(result.messages.map((m) => m.offset), ['1', '3', '5', '7', '9']);
		assert.strictEqual(result.scanned, 10);
		assert.strictEqual(result.truncated, false);
	});

	test('disconnecting stops a running live tail (#13)', async () => {
		const tail = await manager.startTail(cluster, 'orders', () => undefined, () => undefined);
		assert.strictEqual(consumers[0].runOptions?.autoCommit, false);

		await manager.disconnect(cluster.id);

		assert.strictEqual(consumers[0].disconnects, 1);
		await tail.stop();
		assert.strictEqual(consumers[0].disconnects, 1, 'stop after disconnect is a no-op');
	});

	test('a deleted topic gives a clear error instead of a TypeError (#13)', async () => {
		await assert.rejects(manager.describeTopic(cluster, 'gone'), /Topic "gone" no longer exists on "Fake"/);
	});

	test('Create Topic waits out a broker that briefly does not know the new topic', async () => {
		let lookups = 0;
		Object.assign(admin, {
			createTopics: async () => true,
			fetchTopicMetadata: async () => {
				if (++lookups < 3) {
					throw Object.assign(new Error('This server does not host this topic-partition'), { type: 'UNKNOWN_TOPIC_OR_PARTITION' });
				}
				return { topics: [{ name: 'fresh', partitions: [{ partitionId: 0, leader: 1, replicas: [1], isr: [1] }] }] };
			},
		});

		await manager.createTopic(cluster, 'fresh', 1, 1);

		assert.strictEqual(lookups, 3);
	});

	test('the producer stays connected between sends', async () => {
		await manager.produce(cluster, 'orders', { value: 'a' });
		await manager.produce(cluster, 'orders', { value: 'b', key: 'k', headers: { h: '1' } });

		assert.strictEqual(producers.length, 1);
		assert.strictEqual(producers[0].connects, 1);
		assert.strictEqual(producers[0].disconnects, 0);
		assert.strictEqual(producers[0].sent.length, 2);

		await manager.disconnect(cluster.id);
		await new Promise((r) => setImmediate(r));
		assert.strictEqual(producers[0].disconnects, 1);
	});

	test('produceBatch sends in chunks and reports progress (#20)', async () => {
		const progress: number[] = [];
		const sent = await manager.produceBatch(cluster, 'orders', Array.from({ length: 250 }, (_, i) => ({ value: String(i) })), (n) => progress.push(n));
		assert.strictEqual(sent, 250);
		assert.deepStrictEqual(progress, [100, 200, 250]);
		assert.strictEqual(producers[0].sent.length, 3);
	});
});

suite('ClusterManager settings', () => {
	let manager: ClusterManager;

	async function clear(): Promise<void> {
		await vscode.workspace.getConfiguration('kafka').update('clusters', undefined, vscode.ConfigurationTarget.Global);
	}

	setup(async () => {
		await clear();
		manager = new ClusterManager();
	});

	teardown(async () => {
		manager.dispose();
		await clear();
	});

	test('clusters added without a workspace go to user settings (#22)', async () => {
		const cluster = await manager.addCluster('Local', ['localhost:9092']);
		assert.strictEqual(manager.getClusterSource(cluster.id), 'user');
		if (!vscode.workspace.workspaceFolders?.length) {
			await assert.rejects(manager.addCluster('Shared', ['b:9092'], {}, 'workspace'), /Open a folder or workspace/);
		}
	});

	test('a hand edit that removes a connected cluster refreshes listeners and forgets it (#12)', async () => {
		const cluster = await manager.addCluster('Local', ['localhost:9092']);
		(manager as unknown as { kafkaInstances: Map<string, unknown> }).kafkaInstances.set(cluster.id, {
			admin: () => new FakeAdmin([]),
		});
		await manager.connect(cluster);
		assert.strictEqual(manager.getStatus(cluster.id), 'connected');

		const changed = new Promise<void>((resolve) => {
			const sub = manager.onDidChangeClusters(() => {
				if (!manager.getCluster(cluster.id)) {
					sub.dispose();
					resolve();
				}
			});
		});
		// Simulates editing settings.json by hand, bypassing the manager.
		await vscode.workspace.getConfiguration('kafka').update('clusters', [], vscode.ConfigurationTarget.Global);
		await changed;
		// The listener runs asynchronously after the change event.
		for (let i = 0; i < 20 && manager.getStatus(cluster.id) !== 'disconnected'; i++) {
			await new Promise((r) => setTimeout(r, 10));
		}

		assert.strictEqual(manager.getStatus(cluster.id), 'disconnected');
		await assert.rejects(manager.listTopics(cluster), /Not connected/);
	});

	test('Schema Registry settings are saved with the cluster and can be removed (#18)', async () => {
		const cluster = await manager.addCluster('Local', ['localhost:9092']);
		await manager.updateSchemaRegistry(cluster.id, { url: 'http://localhost:8081' });
		assert.deepStrictEqual(manager.getCluster(cluster.id)?.schemaRegistry, { url: 'http://localhost:8081' });
		assert.ok(await manager.getSchemaRegistry(manager.getCluster(cluster.id)!));

		await manager.updateSchemaRegistry(cluster.id, undefined);
		assert.strictEqual(manager.getCluster(cluster.id)?.schemaRegistry, undefined);
	});
});
