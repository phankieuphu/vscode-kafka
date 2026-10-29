import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { RawClusterSnapshot, RawGroup, RawWatermark } from '../kafka/dashboard';
import { detectIssues, diffIssues, GROWTH_SCANS, isDeadLetterTopic, ISSUE_RULES, looksLikeTypo, ScanMemory } from '../kafka/issueRules';
import { TopicInfo } from '../kafka/types';

function topic(name: string, partitions = 1, opts: { leader?: number; isr?: number[] } = {}): TopicInfo {
	return {
		name,
		partitions: Array.from({ length: partitions }, (_, i) => ({
			partitionId: i,
			leader: opts.leader ?? 1,
			replicas: [1],
			isr: opts.isr ?? [1],
		})),
	};
}

function snapshot(parts: {
	topics?: TopicInfo[];
	watermarks?: Record<string, RawWatermark[]>;
	groups?: RawGroup[];
	controllerId?: number | null;
}): RawClusterSnapshot {
	return {
		clusterId: 'c',
		controllerId: parts.controllerId === undefined ? 1 : parts.controllerId,
		brokers: [{ nodeId: 1, host: 'localhost', port: 9092 }],
		topics: parts.topics ?? [],
		watermarks: new Map(Object.entries(parts.watermarks ?? {})),
		groups: parts.groups ?? [],
	};
}

function group(groupId: string, state: string, offsets: RawGroup['offsets'], memberCount = state === 'Stable' ? 1 : 0): RawGroup {
	return { groupId, state, memberCount, offsets };
}

const rules = (raw: RawClusterSnapshot, previous?: ScanMemory) => detectIssues(raw, previous).issues.map((i) => i.rule);

suite('Dev mode issue rules', () => {
	test('a healthy cluster has no issues', () => {
		const raw = snapshot({
			topics: [topic('orders')],
			watermarks: { orders: [{ partition: 0, low: '0', high: '10' }] },
			groups: [group('app', 'Stable', [{ topic: 'orders', partitions: [{ partition: 0, offset: '10' }] }])],
		});
		assert.deepStrictEqual(detectIssues(raw).issues, []);
	});

	test('no controller, offline and under-replicated partitions, most severe first', () => {
		const raw = snapshot({
			controllerId: null,
			topics: [topic('a', 2, { leader: -1 }), { name: 'b', partitions: [{ partitionId: 0, leader: 1, replicas: [1, 2], isr: [1] }] }],
		});
		const { issues } = detectIssues(raw);
		assert.deepStrictEqual(issues.map((i) => [i.level, i.rule]), [
			['crit', 'noController'],
			['crit', 'offlinePartitions'],
			['warn', 'underReplicated'],
		]);
		assert.match(issues[1].text, /2 partitions of "a"/);
	});

	test('offsets deleted by retention and past the end of a recreated topic', () => {
		const raw = snapshot({
			topics: [topic('events', 2)],
			watermarks: { events: [{ partition: 0, low: '500', high: '600' }, { partition: 1, low: '0', high: '5' }] },
			groups: [group('app', 'Stable', [{ topic: 'events', partitions: [{ partition: 0, offset: '10' }, { partition: 1, offset: '80' }] }])],
		});
		assert.deepStrictEqual(rules(raw).sort(), ['offsetBehindRetention', 'offsetBeyondLogEnd']);
	});

	test('uncommitted partitions (-1) are not out of range', () => {
		const raw = snapshot({
			topics: [topic('events')],
			watermarks: { events: [{ partition: 0, low: '500', high: '600' }] },
			groups: [group('app', 'Stable', [{ topic: 'events', partitions: [{ partition: 0, offset: '-1' }] }])],
		});
		assert.deepStrictEqual(rules(raw), []);
	});

	test('offsets left for a deleted topic', () => {
		const raw = snapshot({ groups: [group('old', 'Empty', [{ topic: 'gone', partitions: [{ partition: 0, offset: '3' }] }])] });
		assert.deepStrictEqual(rules(raw), ['orphanedOffsets']);
	});

	test('lag on a group nobody is consuming', () => {
		const raw = snapshot({
			topics: [topic('orders')],
			watermarks: { orders: [{ partition: 0, low: '0', high: '100' }] },
			groups: [group('app', 'Empty', [{ topic: 'orders', partitions: [{ partition: 0, offset: '40' }] }])],
		});
		const [issue] = detectIssues(raw).issues;
		assert.strictEqual(issue.rule, 'lagWithoutMembers');
		assert.strictEqual(issue.group, 'app');
		assert.match(issue.text, /60 messages behind/);
	});

	test('a rebalance counts as stuck only when it lasts across two scans', () => {
		const raw = snapshot({ groups: [group('app', 'PreparingRebalance', [])] });
		const first = detectIssues(raw);
		assert.deepStrictEqual(first.issues, []);
		assert.deepStrictEqual(rules(raw, first.memory), ['stuckRebalance']);
	});

	test('lag growing in every scan while consumers run', () => {
		const at = (offset: string, high: string) =>
			snapshot({
				topics: [topic('orders')],
				watermarks: { orders: [{ partition: 0, low: '0', high }] },
				groups: [group('app', 'Stable', [{ topic: 'orders', partitions: [{ partition: 0, offset }] }])],
			});
		let memory: ScanMemory | undefined;
		const seen: string[][] = [];
		for (let i = 0; i <= GROWTH_SCANS; i++) {
			const result = detectIssues(at('0', String(10 * (i + 1))), memory);
			memory = result.memory;
			seen.push(result.issues.map((x) => x.rule));
		}
		assert.deepStrictEqual(seen.slice(0, GROWTH_SCANS), Array(GROWTH_SCANS).fill([]));
		assert.deepStrictEqual(seen[GROWTH_SCANS], ['growingLag']);
		// A scan where lag stays flat ends the streak.
		assert.deepStrictEqual(rules(at('0', String(10 * (GROWTH_SCANS + 1))), memory), []);
	});

	test('dead-letter topics: a note while they hold messages, a warning when new ones arrive', () => {
		const dlq = (high: string) => snapshot({ topics: [topic('orders.DLT')], watermarks: { 'orders.DLT': [{ partition: 0, low: '0', high }] } });
		const first = detectIssues(dlq('3'));
		assert.deepStrictEqual(first.issues.map((i) => i.level), ['info']);
		const second = detectIssues(dlq('5'), first.memory);
		assert.deepStrictEqual(second.issues.map((i) => i.level), ['warn', 'info']);
		assert.match(second.issues[0].text, /2 new message/);
		assert.deepStrictEqual(diffIssues(first.issues, second.issues).added.map((i) => i.level), ['warn']);
		assert.deepStrictEqual(detectIssues(dlq('5'), second.memory).issues.map((i) => i.level), ['info']);
	});

	test('recognizes dead-letter topic names', () => {
		for (const name of ['orders.dlq', 'orders-dlt', 'orders_DLQ', 'ordersDLT', 'payments.dead-letter', 'dlq']) {
			assert.ok(isDeadLetterTopic(name), name);
		}
		for (const name of ['orders', 'handler', '__consumer_offsets', 'deadline']) {
			assert.ok(!isDeadLetterTopic(name), name);
		}
	});

	test('near-identical topic names', () => {
		assert.ok(looksLikeTypo('orders', 'order'));
		assert.ok(looksLikeTypo('user-events', 'user_events'));
		assert.ok(looksLikeTypo('Payments', 'payments'));
		assert.ok(looksLikeTypo('paymnets', 'payments') === false, 'two edits is not flagged');
		assert.ok(!looksLikeTypo('events-1', 'events-2'));
		assert.ok(!looksLikeTypo('abc', 'abd'), 'short names are skipped');
		const raw = snapshot({ topics: [topic('orders'), topic('order'), topic('__consumer_offsets'), topic('_schemas')] });
		assert.deepStrictEqual(rules(raw), ['similarTopicNames']);
	});

	test('ignored rules are skipped', () => {
		const raw = snapshot({ controllerId: null, topics: [topic('orders'), topic('order')] });
		assert.deepStrictEqual(detectIssues(raw, undefined, new Set(['similarTopicNames'])).issues.map((i) => i.rule), ['noController']);
	});

	test('diffIssues reports added and resolved by id', () => {
		const a = detectIssues(snapshot({ controllerId: null })).issues;
		const b = detectIssues(snapshot({ topics: [topic('x', 1, { leader: -1 })] })).issues;
		const { added, resolved } = diffIssues(a, b);
		assert.deepStrictEqual(added.map((i) => i.rule), ['offlinePartitions']);
		assert.deepStrictEqual(resolved.map((i) => i.rule), ['noController']);
		assert.deepStrictEqual(diffIssues(b, b), { added: [], resolved: [] });
	});

	test('the settings list every rule', () => {
		const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
		const declared = manifest.contributes.configuration.properties['kafka.devMode.ignoredRules'].items.enum;
		assert.deepStrictEqual(declared, [...ISSUE_RULES]);
	});
});
