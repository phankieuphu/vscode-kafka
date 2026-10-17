import * as assert from 'assert';
import { brokerConfigRisks, formatRisks, topicConfigRisks, TopicFacts } from '../kafka/configRules';
import { analyzeLag, classifyTrend, LagHistory, LagSample, toSample } from '../kafka/lagTrend';
import { BrokerConfigEntry, GroupOffsetEntry, TopicConfigEntry } from '../kafka/types';

const cfg = (entries: Record<string, string>): TopicConfigEntry[] =>
	Object.entries(entries).map(([name, value]) => ({ name, value, isDefault: false, readOnly: false, isSensitive: false, isTopicOverride: true }));
const facts = (over: Partial<TopicFacts> = {}): TopicFacts => ({
	replicationFactor: 3,
	partitions: [{ leader: 1 }, { leader: 2 }, { leader: 3 }],
	underReplicated: 0,
	offline: 0,
	messageCount: '10',
	brokerCount: 3,
	...over,
});
const settings = (risks: ReturnType<typeof topicConfigRisks>) => risks.map((r) => `${r.level}:${r.setting}`);

suite('Topic config rules', () => {
	test('a healthy topic has no findings', () => {
		assert.deepStrictEqual(topicConfigRisks(facts(), cfg({ 'min.insync.replicas': '2', 'retention.ms': '604800000' })), []);
		assert.strictEqual(formatRisks([]), "No risky settings found by Kafka Manager's rules.");
	});

	test('durability: min.insync.replicas against the replication factor, RF 1, unclean election', () => {
		assert.deepStrictEqual(settings(topicConfigRisks(facts(), cfg({ 'min.insync.replicas': '4' }))), ['crit:min.insync.replicas']);
		assert.deepStrictEqual(settings(topicConfigRisks(facts(), cfg({ 'min.insync.replicas': '3' }))), ['warn:min.insync.replicas']);
		assert.deepStrictEqual(settings(topicConfigRisks(facts(), cfg({ 'min.insync.replicas': '1' }))), ['info:min.insync.replicas']);
		assert.deepStrictEqual(settings(topicConfigRisks(facts({ replicationFactor: 1 }), cfg({}))), ['warn:replication.factor']);
		assert.deepStrictEqual(settings(topicConfigRisks(facts(), cfg({ 'unclean.leader.election.enable': 'true' }))), ['warn:unclean.leader.election.enable']);
	});

	test('unbounded retention is a warning only on a high-volume topic', () => {
		assert.deepStrictEqual(settings(topicConfigRisks(facts(), cfg({ 'retention.ms': '-1' }))), ['info:retention.ms']);
		assert.deepStrictEqual(settings(topicConfigRisks(facts({ messageCount: '5000000' }), cfg({ 'retention.ms': '-1' }))), ['warn:retention.ms']);
		assert.deepStrictEqual(topicConfigRisks(facts(), cfg({ 'retention.ms': '-1', 'retention.bytes': '1073741824' })), []);
		assert.deepStrictEqual(topicConfigRisks(facts(), cfg({ 'retention.ms': '-1', 'cleanup.policy': 'compact' })), []);
	});

	test('compaction with no keys seen, only when messages were sampled', () => {
		assert.deepStrictEqual(settings(topicConfigRisks(facts({ keysSeen: false }), cfg({ 'cleanup.policy': 'compact' }))), ['warn:cleanup.policy']);
		assert.deepStrictEqual(topicConfigRisks(facts({ keysSeen: true }), cfg({ 'cleanup.policy': 'compact' })), []);
		assert.deepStrictEqual(topicConfigRisks(facts(), cfg({ 'cleanup.policy': 'compact,delete' })), []);
	});

	test('layout: offline, under-replicated, leaders piled on one broker; most severe first', () => {
		const skewed = facts({ partitions: [1, 1, 1, 1, 1, 2].map((leader) => ({ leader })), offline: 1, underReplicated: 2 });
		assert.deepStrictEqual(settings(topicConfigRisks(skewed, cfg({}))), ['crit:layout', 'warn:layout', 'warn:layout']);
	});
});

suite('Broker config rules', () => {
	const entry = (name: string, value: string): BrokerConfigEntry => ({ name, value, isDefault: false, readOnly: false, isSensitive: false, source: 'static' });
	const brokers = [1, 2, 3].map((nodeId) => ({ nodeId, host: 'h', port: 9092, isController: nodeId === 1, leaderCount: nodeId === 1 ? 30 : 5, replicaCount: 40 }));

	test('flags redundancy, auto-create, leader imbalance and missing rack', () => {
		const risks = brokerConfigRisks(
			[entry('default.replication.factor', '1'), entry('offsets.topic.replication.factor', '1'), entry('auto.create.topics.enable', 'true')],
			brokers,
		);
		assert.deepStrictEqual(risks.map((r) => r.setting), ['default.replication.factor', 'layout', 'offsets.topic.replication.factor', 'auto.create.topics.enable', 'broker.rack']);
	});

	test('a single balanced broker with a rack is fine', () => {
		assert.deepStrictEqual(brokerConfigRisks([], [{ ...brokers[0], leaderCount: 3 }], 'az1'), []);
	});
});

function sample(at: number, parts: Array<[committed: number, high: number]>): LagSample {
	const entries: GroupOffsetEntry[] = parts.map(([c, h], partition) => ({ topic: 't', partition, offset: String(c), low: '0', high: String(h), lag: String(h - c) }));
	return toSample(entries, at);
}

suite('Lag trend', () => {
	test('classifies flat, growing, draining and spiky series', () => {
		assert.strictEqual(classifyTrend([10n, 10n]), 'unknown');
		assert.strictEqual(classifyTrend([100n, 101n, 99n, 100n]), 'flat');
		assert.strictEqual(classifyTrend([0n, 0n, 0n]), 'flat');
		assert.strictEqual(classifyTrend([100n, 200n, 300n, 380n, 500n]), 'growing');
		assert.strictEqual(classifyTrend([500n, 400n, 300n, 320n, 100n]), 'draining');
		assert.strictEqual(classifyTrend([50n, 900n, 1200n, 400n, 80n]), 'spiky');
	});

	test('the ring buffer keeps the last N readings per group', () => {
		const h = new LagHistory(3);
		for (let i = 0; i < 5; i++) {
			h.push('k', sample(i, [[0, i]]));
		}
		assert.deepStrictEqual(h.get('k').map((s) => s.at), [2, 3, 4]);
		h.retain(new Set());
		assert.deepStrictEqual(h.get('k'), []);
	});

	test('one stuck partition while others progress', () => {
		const samples = [0, 1, 2].map((i) => sample(i, [[100 + i * 50, 200 + i * 50], [10, 30 + i * 40]]));
		const { findings } = analyzeLag(samples, { state: 'Stable', memberCount: 2 });
		assert.deepStrictEqual(findings.map((f) => f.kind).slice(0, 1), ['stuck-partition']);
		assert.strictEqual(findings[0].partition, 1);
	});

	test('nothing committed anywhere while messages arrive: consumer down', () => {
		const samples = [0, 1, 2].map((i) => sample(i, [[100, 200 + i * 10], [50, 60 + i * 10]]));
		assert.deepStrictEqual(analyzeLag(samples).findings.map((f) => f.kind), ['consumer-down']);
		const empty = analyzeLag(samples, { state: 'Empty', memberCount: 0 }).findings.map((f) => f.kind);
		assert.deepStrictEqual(empty, ['consumer-down']);
	});

	test('rebalancing, a producer burst, and catching up', () => {
		assert.strictEqual(analyzeLag([], { state: 'PreparingRebalance', memberCount: 3 }).findings[0].kind, 'rebalancing');
		const burst = [[0, 50], [0, 1000], [800, 1300], [1290, 1350]].map(([c, h], i) => sample(i, [[c, h]]));
		assert.ok(analyzeLag(burst).findings.some((f) => f.kind === 'producer-burst'));
		const draining = [[0, 1000], [300, 1000], [600, 1000], [900, 1000]].map(([c, h], i) => sample(i, [[c, h]]));
		assert.deepStrictEqual(analyzeLag(draining).findings.map((f) => f.kind), ['catching-up']);
	});

	test('partitions with lag but no consumer', () => {
		const samples = [0, 1, 2].map((i) => sample(i, [[10 * i, 10 * i + 5], [10 * i, 10 * i + 5]]));
		const { findings } = analyzeLag(samples, { state: 'Stable', memberCount: 1, assigned: new Set(['t/0']) });
		assert.ok(findings.some((f) => f.kind === 'unassigned' && /t\/1/.test(f.text)));
	});
});
