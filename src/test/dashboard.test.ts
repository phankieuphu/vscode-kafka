import * as assert from 'assert';
import { buildClusterOverview, listIssues, RawClusterSnapshot } from '../kafka/dashboard';

function snapshot(overrides: Partial<RawClusterSnapshot> = {}): RawClusterSnapshot {
	return {
		clusterId: 'abc',
		controllerId: 1,
		brokers: [
			{ nodeId: 2, host: 'b2', port: 9092 },
			{ nodeId: 1, host: 'b1', port: 9092 },
		],
		topics: [
			{
				name: 'orders',
				partitions: [
					{ partitionId: 0, leader: 1, replicas: [1, 2], isr: [1, 2] },
					{ partitionId: 1, leader: 2, replicas: [2, 1], isr: [2] },
					{ partitionId: 2, leader: -1, replicas: [1, 2], isr: [] },
				],
			},
		],
		watermarks: new Map([
			['orders', [
				{ partition: 0, low: '10', high: '110' },
				{ partition: 1, low: '0', high: '50' },
				{ partition: 2, low: '0', high: '0' },
			]],
		]),
		groups: [
			{
				groupId: 'billing',
				state: 'Stable',
				memberCount: 2,
				offsets: [{ topic: 'orders', partitions: [
					{ partition: 0, offset: '100' },
					{ partition: 1, offset: '-1' },
				] }],
			},
		],
		...overrides,
	};
}

suite('buildClusterOverview', () => {
	test('aggregates partition health per topic', () => {
		const { topics, totals } = buildClusterOverview(snapshot());

		assert.deepStrictEqual(topics[0], {
			name: 'orders',
			partitionCount: 3,
			replicationFactor: 2,
			underReplicated: 2,
			offline: 1,
			messageCount: '150',
		});
		assert.strictEqual(totals.partitions, 3);
		assert.strictEqual(totals.underReplicated, 2);
		assert.strictEqual(totals.offline, 1);
	});

	test('counts leaders and replicas per broker and flags the controller', () => {
		const { brokers } = buildClusterOverview(snapshot());

		assert.deepStrictEqual(brokers.map((b) => b.nodeId), [1, 2]);
		assert.deepStrictEqual(brokers[0], { nodeId: 1, host: 'b1', port: 9092, isController: true, leaderCount: 1, replicaCount: 3 });
		assert.deepStrictEqual(brokers[1], { nodeId: 2, host: 'b2', port: 9092, isController: false, leaderCount: 1, replicaCount: 3 });
	});

	test('sums group lag, treating an uncommitted partition as fully lagging', () => {
		const { groups, totals } = buildClusterOverview(snapshot());

		// partition 0: 110 - 100 = 10; partition 1: no commit -> high (50).
		assert.strictEqual(groups[0].totalLag, '60');
		assert.deepStrictEqual(groups[0].topics, ['orders']);
		assert.strictEqual(totals.totalLag, '60');
	});

	test('keeps counts exact beyond Number.MAX_SAFE_INTEGER', () => {
		const huge = '18014398509481985'; // 2^54 + 1
		const { topics } = buildClusterOverview(snapshot({
			watermarks: new Map([['orders', [{ partition: 0, low: '0', high: huge }]]]),
		}));

		assert.strictEqual(topics[0].messageCount, huge);
	});

	test('handles a cluster with no controller, topics or groups', () => {
		const overview = buildClusterOverview(snapshot({ controllerId: null, topics: [], watermarks: new Map(), groups: [] }));

		assert.strictEqual(overview.brokers.some((b) => b.isController), false);
		assert.deepStrictEqual(overview.totals, {
			brokers: 2, topics: 0, partitions: 0, underReplicated: 0, offline: 0, groups: 0, totalLag: '0',
		});
	});

	test('lists critical issues before warnings, naming what to open', () => {
		const overview = buildClusterOverview(snapshot({
			groups: [{ groupId: 'etl', state: 'Empty', memberCount: 0, offsets: [{ topic: 'orders', partitions: [{ partition: 0, offset: '100' }] }] }],
		}));

		assert.deepStrictEqual(listIssues(overview), [
			{ level: 'crit', kind: 'topic', name: 'orders', text: '1 offline partition in' },
			{ level: 'warn', kind: 'topic', name: 'orders', text: '2 under-replicated partitions in' },
			{ level: 'warn', kind: 'group', name: 'etl', text: 'has lag but no members' },
		]);
	});

	test('reports a missing controller and nothing for a healthy cluster', () => {
		const healthy = snapshot({ topics: [], groups: [] });
		assert.deepStrictEqual(listIssues(buildClusterOverview(healthy)), []);
		assert.deepStrictEqual(listIssues(buildClusterOverview({ ...healthy, controllerId: null })), [
			{ level: 'crit', kind: 'cluster', text: 'No active controller' },
		]);
	});
});
