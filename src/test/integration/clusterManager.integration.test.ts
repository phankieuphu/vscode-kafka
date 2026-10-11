import * as assert from 'assert';
import * as crypto from 'crypto';
import { Kafka, logLevel } from 'kafkajs';
import { ClusterManager, INTERNAL_GROUP_PREFIX } from '../../kafka/clusterManager';
import { ClusterConfig, ConsumedMessage } from '../../kafka/types';

/**
 * Runs ClusterManager against a real broker. Set KAFKA_BROKERS (e.g.
 * localhost:9092) to enable; CI starts apache/kafka in KRaft mode for it.
 * Every test works on its own randomly named topic and group.
 */
const brokers = process.env.KAFKA_BROKERS?.split(',').map((b) => b.trim()).filter(Boolean) ?? [];

const waitFor = async (what: string, check: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> => {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await check()) {
			return;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	assert.fail(`Timed out waiting for ${what}`);
};

suite('ClusterManager against a real broker', function () {
	this.timeout(90_000);

	const cluster: ClusterConfig = { id: `it-${crypto.randomUUID()}`, name: 'Integration', brokers };
	const kafka = new Kafka({ clientId: 'vscode-kafka-it', brokers, logLevel: logLevel.NOTHING });
	let manager: ClusterManager;
	let topic: string;

	suiteSetup(function () {
		if (brokers.length === 0) {
			this.skip();
		}
	});

	setup(async () => {
		manager = new ClusterManager();
		await manager.connect(cluster);
		topic = `it-${crypto.randomUUID().slice(0, 8)}`;
		await manager.createTopic(cluster, topic, 2, 1);
	});

	teardown(async () => {
		if (manager.getStatus(cluster.id) === 'connected') {
			await manager.deleteTopic(cluster, topic).catch(() => undefined);
		}
		await manager.disconnect(cluster.id);
		manager.dispose();
	});

	async function produce(count: number, partition = 0): Promise<void> {
		await manager.produceBatch(cluster, topic, Array.from({ length: count }, (_, i) => ({
			key: `k${i}`, value: JSON.stringify({ n: i }), partition, headers: { seq: String(i) },
		})));
	}

	/** Ids of the browser's/tail's temporary groups currently on the broker. */
	async function internalGroups(): Promise<Set<string>> {
		const admin = kafka.admin();
		await admin.connect();
		try {
			const { groups } = await admin.listGroups();
			return new Set(groups.map((g) => g.groupId).filter((id) => id.startsWith(INTERNAL_GROUP_PREFIX)));
		} finally {
			await admin.disconnect();
		}
	}

	/** Fails if a temporary group created since `before` is still on the broker. */
	async function assertNoNewInternalGroups(before: Set<string>): Promise<void> {
		await waitFor('temporary groups to be removed', async () => [...(await internalGroups())].every((id) => before.has(id)));
	}

	/** Commits `offset` on partition 0 for a fresh group, using a real consumer, then leaves. */
	async function groupAt(offset: number): Promise<string> {
		const groupId = `it-group-${crypto.randomUUID().slice(0, 8)}`;
		const admin = kafka.admin();
		await admin.connect();
		try {
			await admin.setOffsets({ groupId, topic, partitions: [{ partition: 0, offset: String(offset) }, { partition: 1, offset: '0' }] });
		} finally {
			await admin.disconnect();
		}
		return groupId;
	}

	test('connects, lists and describes the topic, and disconnects', async () => {
		assert.strictEqual(manager.getStatus(cluster.id), 'connected');
		assert.ok((await manager.listTopics(cluster)).some((t) => t.name === topic));
		assert.strictEqual((await manager.describeTopic(cluster, topic)).partitions.length, 2);
		await manager.disconnect(cluster.id);
		assert.strictEqual(manager.getStatus(cluster.id), 'disconnected');
		await assert.rejects(manager.listTopics(cluster), /Not connected/);
		await manager.connect(cluster);
	});

	test('a deleted topic is reported clearly', async () => {
		await manager.deleteTopic(cluster, topic);
		await waitFor('the topic to disappear', async () => !(await manager.listTopics(cluster)).some((t) => t.name === topic));
		await assert.rejects(manager.describeTopic(cluster, topic), /no longer exists/);
	});

	test('produces, then loads the newest messages without leaving a group behind', async () => {
		await produce(30);
		const before = await internalGroups();
		const messages = await manager.loadRecentMessages(cluster, topic, 10);

		assert.deepStrictEqual(messages.map((m) => m.offset), ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29']);
		assert.strictEqual(messages[0].key, 'k20');
		assert.deepStrictEqual(messages[0].headers, { seq: '20' });

		await assertNoNewInternalGroups(before);
	});

	test('browses from an offset, a timestamp, pages older, and searches', async () => {
		await produce(40);
		const fromOffset = await manager.browse(cluster, topic, { position: { kind: 'offset', offset: '15' }, limit: 5, partition: 0 });
		assert.deepStrictEqual(fromOffset.messages.map((m) => m.offset), ['15', '16', '17', '18', '19']);

		const older = await manager.browse(cluster, topic, { position: { kind: 'before', offsets: { 0: '15' } }, limit: 3 });
		assert.deepStrictEqual(older.messages.map((m) => m.offset), ['12', '13', '14']);

		const future = await manager.browse(cluster, topic, { position: { kind: 'timestamp', timestamp: Date.now() + 3_600_000 }, limit: 5 });
		assert.deepStrictEqual(future.messages, []);
		const past = await manager.browse(cluster, topic, { position: { kind: 'timestamp', timestamp: 0 }, limit: 2, partition: 0 });
		assert.deepStrictEqual(past.messages.map((m) => m.offset), ['0', '1']);

		const found = await manager.browse(cluster, topic, { position: { kind: 'oldest' }, limit: 10, search: '"n":3', scanLimit: 100 });
		// Reading forward, the search stops at the first 10 matches: n = 3, 30…38.
		assert.deepStrictEqual(found.messages.map((m) => m.offset), ['3', '30', '31', '32', '33', '34', '35', '36', '37', '38']);
	});

	test('live tail receives new messages and stops on disconnect', async () => {
		const received: ConsumedMessage[] = [];
		const before = await internalGroups();
		await manager.startTail(cluster, topic, (m) => received.push(m), (e) => assert.fail(String(e)));
		// The tail starts at the end once its group has joined; keep producing until one arrives.
		await waitFor('a tailed message', async () => {
			await produce(1);
			return received.length > 0;
		}, 45_000);
		assert.strictEqual(received[0].partition, 0);

		await manager.disconnect(cluster.id);
		const count = received.length;
		await manager.connect(cluster);
		await produce(3);
		await new Promise((r) => setTimeout(r, 2_000));
		assert.strictEqual(received.length, count, 'no messages after disconnect');
		await assertNoNewInternalGroups(before);
	});

	test('fetches group offsets with lag, and applies every reset mode', async () => {
		await produce(50);
		const groupId = await groupAt(10);
		const offsets = await manager.fetchGroupOffsets(cluster, groupId);
		assert.deepStrictEqual(offsets.find((o) => o.partition === 0), { topic, partition: 0, offset: '10', low: '0', high: '50', lag: '40' });
		assert.strictEqual(await manager.getGroupLag(cluster, groupId), 40n);

		const at = async () => (await manager.fetchGroupOffsets(cluster, groupId)).find((o) => o.partition === 0)!.offset;
		await manager.resetGroupOffsetsTo(cluster, groupId, topic, { mode: 'latest' });
		assert.strictEqual(await at(), '50');
		await manager.resetGroupOffsetsTo(cluster, groupId, topic, { mode: 'earliest' });
		assert.strictEqual(await at(), '0');
		await manager.resetGroupOffsetsTo(cluster, groupId, topic, { mode: 'shift', by: 7 });
		assert.strictEqual(await at(), '7');
		await manager.resetGroupOffsetsTo(cluster, groupId, topic, { mode: 'timestamp', timestamp: Date.now() + 3_600_000 });
		assert.strictEqual(await at(), '50');
		await manager.setGroupOffset(cluster, groupId, topic, 0, '20');
		assert.strictEqual(await at(), '20');
		await manager.setGroupOffsetToEdge(cluster, groupId, topic, 0, 'earliest');
		assert.strictEqual(await at(), '0');

		await manager.deleteConsumerGroup(cluster, groupId);
	});

	test('cluster overview reports the topic and group lag', async () => {
		await produce(5);
		const groupId = await groupAt(2);
		const overview = await manager.getClusterOverview(cluster);

		assert.ok(overview.brokers.length >= 1);
		assert.strictEqual(overview.topics.find((t) => t.name === topic)?.messageCount, '5');
		assert.strictEqual(overview.groups.find((g) => g.groupId === groupId)?.totalLag, '3');
		assert.ok(!overview.groups.some((g) => g.groupId.startsWith(INTERNAL_GROUP_PREFIX)));
		await manager.deleteConsumerGroup(cluster, groupId);
	});

	test('edits topic settings, keeping other overrides, and adds partitions', async () => {
		await manager.alterTopicConfig(cluster, topic, { 'retention.ms': '3600000' });
		await manager.alterTopicConfig(cluster, topic, { 'cleanup.policy': 'compact' });
		const value = async (name: string) => (await manager.getTopicConfig(cluster, topic)).find((e) => e.name === name);
		assert.strictEqual((await value('retention.ms'))?.value, '3600000', 'earlier override survives');
		assert.strictEqual((await value('cleanup.policy'))?.value, 'compact');

		await manager.alterTopicConfig(cluster, topic, { 'retention.ms': null });
		assert.strictEqual((await value('retention.ms'))?.isTopicOverride, false);

		await manager.addPartitions(cluster, topic, 4);
		await waitFor('4 partitions', async () => (await manager.describeTopic(cluster, topic)).partitions.length === 4);
	});

	test('lists brokers with their settings', async () => {
		const [broker] = await manager.listBrokers(cluster);
		const details = await manager.getBrokerDetails(cluster, broker.nodeId);
		assert.ok(details.config.some((c) => c.name === 'log.retention.hours'));
		// The test broker has no authorizer, so ACLs explain that rather than failing obscurely.
		await assert.rejects(manager.listAcls(cluster), /ACLs aren't enabled|SECURITY_DISABLED|authoriz/i);
	});
});
