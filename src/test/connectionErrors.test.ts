import * as assert from 'assert';
import {
	KafkaJSBrokerNotFound,
	KafkaJSConnectionError,
	KafkaJSNumberOfRetriesExceeded,
	KafkaJSProtocolError,
	KafkaJSRequestTimeoutError,
} from 'kafkajs';
import { ClusterManager, isConnectionError } from '../kafka/clusterManager';
import { ClusterConfig } from '../kafka/types';

// The typings declare a no-arg constructor, but at runtime it needs a message.
const BrokerNotFound = KafkaJSBrokerNotFound as unknown as new (message: string) => KafkaJSBrokerNotFound;

function retriesExceeded(cause: Error): KafkaJSNumberOfRetriesExceeded {
	return new KafkaJSNumberOfRetriesExceeded(cause, { retryCount: 5, retryTime: 100 });
}

suite('isConnectionError', () => {
	test('treats broker-unreachable errors as connection loss', () => {
		assert.strictEqual(isConnectionError(new KafkaJSConnectionError('Connection error: ECONNREFUSED')), true);
		assert.strictEqual(isConnectionError(new KafkaJSRequestTimeoutError('Request timed out')), true);
		assert.strictEqual(isConnectionError(new BrokerNotFound('Broker not found')), true);
	});

	test('looks through retries-exceeded to the underlying cause', () => {
		assert.strictEqual(isConnectionError(retriesExceeded(new KafkaJSConnectionError('Connection timeout'))), true);
		assert.strictEqual(isConnectionError(retriesExceeded(new KafkaJSProtocolError('Leader not available'))), false);
	});

	test('ignores request-level and non-KafkaJS errors', () => {
		assert.strictEqual(isConnectionError(new KafkaJSProtocolError('This server does not host this topic-partition')), false);
		assert.strictEqual(isConnectionError(new Error('boom')), false);
		assert.strictEqual(isConnectionError('boom'), false);
		assert.strictEqual(isConnectionError(undefined), false);
	});
});

/** Minimal stand-in for a KafkaJS admin; `failWith` makes the next metadata call reject. */
class FakeAdmin {
	failWith: unknown;
	disconnectCalls = 0;

	constructor(private readonly connectFailWith?: unknown) {}

	async connect(): Promise<void> {}

	async listTopics(): Promise<string[]> {
		if (this.connectFailWith) {
			throw this.connectFailWith;
		}
		return [];
	}

	async fetchTopicMetadata(): Promise<{ topics: [] }> {
		if (this.failWith) {
			throw this.failWith;
		}
		return { topics: [] };
	}

	async disconnect(): Promise<void> {
		this.disconnectCalls++;
	}
}

suite('ClusterManager connection loss', () => {
	const cluster: ClusterConfig = { id: 'test-cluster', name: 'Test', brokers: ['localhost:1'] };
	let manager: ClusterManager;
	/** The admin handed out by the most recent connect(). */
	let admin: FakeAdmin;
	/** When set, the next connect()'s broker round-trip fails with this. */
	let nextConnectFailure: unknown;
	let statusEvents: string[];
	let lostEvents: ClusterConfig[];

	setup(async () => {
		manager = new ClusterManager();
		nextConnectFailure = undefined;
		// Inject a fake Kafka so connect() never touches a real broker; each connect gets a fresh admin.
		(manager as unknown as { kafkaInstances: Map<string, unknown> }).kafkaInstances.set(cluster.id, {
			admin: () => {
				admin = new FakeAdmin(nextConnectFailure);
				nextConnectFailure = undefined;
				return admin;
			},
		});
		await manager.connect(cluster);
		statusEvents = [];
		lostEvents = [];
		manager.onDidChangeStatus((id) => statusEvents.push(`${id}:${manager.getStatus(id)}`));
		manager.onDidLoseConnection((c) => lostEvents.push(c));
	});

	teardown(() => {
		manager.dispose();
	});

	test('a connection error moves the cluster to error and records lastError', async () => {
		const error = new KafkaJSConnectionError('Connection error: ECONNREFUSED');
		admin.failWith = error;

		await assert.rejects(manager.listTopics(cluster), (e) => e === error);

		assert.strictEqual(manager.getStatus(cluster.id), 'error');
		assert.strictEqual(manager.getLastError(cluster.id), 'Connection error: ECONNREFUSED');
		assert.strictEqual(admin.disconnectCalls, 1);
		await assert.rejects(manager.listTopics(cluster), /Not connected/);
	});

	test('retries exhausted on a connection error also moves the cluster to error', async () => {
		admin.failWith = retriesExceeded(new KafkaJSConnectionError('Connection timeout'));

		await assert.rejects(manager.listTopics(cluster));

		assert.strictEqual(manager.getStatus(cluster.id), 'error');
	});

	test('a request-level error leaves the cluster connected', async () => {
		admin.failWith = new KafkaJSProtocolError('This server does not host this topic-partition');

		await assert.rejects(manager.listTopics(cluster));

		assert.strictEqual(manager.getStatus(cluster.id), 'connected');
		assert.strictEqual(manager.getLastError(cluster.id), undefined);
		assert.deepStrictEqual(statusEvents, []);
	});

	test('parallel failures change the status only once', async () => {
		admin.failWith = new KafkaJSConnectionError('Connection closed');

		const results = await Promise.allSettled([manager.listTopics(cluster), manager.listTopics(cluster)]);

		assert.ok(results.every((r) => r.status === 'rejected'));
		assert.deepStrictEqual(statusEvents, [`${cluster.id}:error`]);
		assert.strictEqual(admin.disconnectCalls, 1);
	});

	test('a failure arriving after an explicit disconnect is ignored', async () => {
		let reject!: (e: unknown) => void;
		admin.fetchTopicMetadata = () => new Promise((_, r) => (reject = r));

		const pending = manager.listTopics(cluster);
		await manager.disconnect(cluster.id);
		reject(new KafkaJSConnectionError('Connection closed'));
		await assert.rejects(pending);

		assert.strictEqual(manager.getStatus(cluster.id), 'disconnected');
		assert.strictEqual(manager.getLastError(cluster.id), undefined);
	});

	test('connection loss fires onDidLoseConnection once with the cluster', async () => {
		admin.failWith = new KafkaJSConnectionError('Connection closed');

		await Promise.allSettled([manager.listTopics(cluster), manager.listTopics(cluster)]);

		assert.deepStrictEqual(lostEvents, [cluster]);
	});

	test('request-level errors and explicit disconnects do not fire onDidLoseConnection', async () => {
		admin.failWith = new KafkaJSProtocolError('This server does not host this topic-partition');
		await assert.rejects(manager.listTopics(cluster));
		await manager.disconnect(cluster.id);

		assert.deepStrictEqual(lostEvents, []);
	});

	test('status listeners can use the admin as soon as the cluster reports connected', async () => {
		await manager.disconnect(cluster.id);
		let listenerResult: Promise<unknown> | undefined;
		const sub = manager.onDidChangeStatus((id) => {
			if (manager.getStatus(id) === 'connected') {
				listenerResult = manager.listTopics(cluster);
			}
		});

		await manager.connect(cluster);
		sub.dispose();

		assert.ok(listenerResult, 'listener never saw "connected"');
		await listenerResult;
	});
});

suite('ClusterManager.reconnect', () => {
	const cluster: ClusterConfig = { id: 'test-cluster', name: 'Test', brokers: ['localhost:1'] };
	let manager: ClusterManager;
	let admins: FakeAdmin[];
	let nextConnectFailure: unknown;

	setup(async () => {
		manager = new ClusterManager();
		admins = [];
		nextConnectFailure = undefined;
		(manager as unknown as { kafkaInstances: Map<string, unknown> }).kafkaInstances.set(cluster.id, {
			admin: () => {
				const admin = new FakeAdmin(nextConnectFailure);
				nextConnectFailure = undefined;
				admins.push(admin);
				return admin;
			},
		});
		await manager.connect(cluster);
	});

	teardown(() => {
		manager.dispose();
	});

	test('recovers from the error state with a fresh admin', async () => {
		admins[0].failWith = new KafkaJSConnectionError('Connection closed');
		await assert.rejects(manager.listTopics(cluster));
		assert.strictEqual(manager.getStatus(cluster.id), 'error');

		await manager.reconnect(cluster);

		assert.strictEqual(admins.length, 2);
		assert.strictEqual(manager.getStatus(cluster.id), 'connected');
		assert.strictEqual(manager.getLastError(cluster.id), undefined);
		assert.deepStrictEqual(await manager.listTopics(cluster), []);
	});

	test('replaces a live connection, closing the old admin', async () => {
		await manager.reconnect(cluster);

		assert.strictEqual(admins.length, 2);
		assert.strictEqual(admins[0].disconnectCalls, 1);
		assert.strictEqual(manager.getStatus(cluster.id), 'connected');
	});

	test('rejects and records the error when the brokers are still down', async () => {
		nextConnectFailure = new KafkaJSConnectionError('Connection error: ECONNREFUSED');

		await assert.rejects(manager.reconnect(cluster), /ECONNREFUSED/);

		assert.strictEqual(manager.getStatus(cluster.id), 'error');
		assert.strictEqual(manager.getLastError(cluster.id), 'Connection error: ECONNREFUSED');
	});
});
