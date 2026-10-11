import * as assert from 'assert';
import { evaluateLag } from '../lagMonitor';
import { expandTemplate, hasTemplateVariables } from '../kafka/templates';
import { describeChanges, mergeTopicOverrides } from '../kafka/topicConfig';
import { exportMessages, kcatProduceCommand, parseBatch } from '../kafka/transfer';
import { ConsumedMessage, TopicConfigEntry } from '../kafka/types';

suite('expandTemplate', () => {
	const context = { seq: 3, now: new Date('2026-01-02T03:04:05.006Z'), random: () => 0.5, uuid: () => 'u-1' };

	test('replaces every known variable', () => {
		assert.strictEqual(
			expandTemplate('{{uuid}} {{now}} {{nowMs}} {{random.int}} {{ seq }}', context),
			'u-1 2026-01-02T03:04:05.006Z 1767323045006 1073741824 3',
		);
	});

	test('leaves unknown variables visible', () => {
		assert.strictEqual(expandTemplate('{{nope}}-{{seq}}', context), '{{nope}}-3');
		assert.ok(hasTemplateVariables('a {{uuid}}'));
		assert.ok(!hasTemplateVariables('{ "a": 1 }'));
	});
});

const message: ConsumedMessage = {
	partition: 2, offset: '41', key: "it's", value: 'line 1\nline 2', timestamp: '1700000000000',
	headers: { trace: 'x' }, valueEncoding: 'utf-8',
};

suite('export and batch produce', () => {
	test('NDJSON export reads back as the same records', () => {
		const text = exportMessages([message, { ...message, offset: '42', key: null }], 'ndjson');
		assert.strictEqual(text.split('\n').filter(Boolean).length, 2);
		assert.deepStrictEqual(parseBatch(text), [
			// The partition is kept, so replaying an export reproduces the original layout.
			{ value: 'line 1\nline 2', key: "it's", partition: 2, headers: { trace: 'x' } },
			{ value: 'line 1\nline 2', partition: 2, headers: { trace: 'x' } },
		]);
	});

	test('JSON arrays may hold object values and a partition', () => {
		assert.deepStrictEqual(parseBatch('[{"value":{"a":1},"partition":1,"key":5}]'), [
			{ value: '{"a":1}', partition: 1, key: '5' },
		]);
	});

	test('reports which record is wrong', () => {
		assert.throws(() => parseBatch('{"value":"a"}\n{"key":"b"}'), /Record 2 has no "value"/);
		assert.throws(() => parseBatch('{"value":"a"}\nnot json'), /Line 2 isn't valid JSON/);
		assert.throws(() => parseBatch('[{"value":"a","partition":-1}]'), /invalid "partition"/);
		assert.deepStrictEqual(parseBatch('  \n'), []);
	});

	test('kcat command quotes safely and never includes a password', () => {
		const cmd = kcatProduceCommand(
			{ id: 'c', name: 'C', brokers: ['b1:9093', 'b2:9093'], ssl: true, sasl: { mechanism: 'scram-sha-512', username: 'alice' } },
			'orders',
			message,
		);
		assert.strictEqual(
			cmd,
			"printf '%s' 'line 1\nline 2' | kcat -P -b 'b1:9093,b2:9093' -t 'orders' -p 2 -X security.protocol=SASL_SSL " +
				"-X sasl.mechanisms=SCRAM-SHA-512 -X sasl.username='alice' -X sasl.password=\"$KAFKA_PASSWORD\" -k 'it'\\''s' -H 'trace=x' /dev/stdin",
		);
	});
});

const entry = (name: string, value: string, extra: Partial<TopicConfigEntry> = {}): TopicConfigEntry => ({
	name, value, isDefault: false, readOnly: false, isSensitive: false, isTopicOverride: true, ...extra,
});

suite('mergeTopicOverrides', () => {
	const current = [
		entry('retention.ms', '1000'),
		entry('cleanup.policy', 'delete', { isTopicOverride: false, isDefault: true }),
		entry('min.insync.replicas', '2', { isTopicOverride: false }),
	];

	test('keeps existing topic overrides and applies changes on top', () => {
		assert.deepStrictEqual(mergeTopicOverrides(current, { 'cleanup.policy': 'compact' }), [
			{ name: 'cleanup.policy', value: 'compact' },
			{ name: 'retention.ms', value: '1000' },
		]);
	});

	test('null resets a setting to its default by leaving it out', () => {
		assert.deepStrictEqual(mergeTopicOverrides(current, { 'retention.ms': null }), []);
	});

	test('refuses read-only settings and sensitive overrides it would lose', () => {
		assert.throws(() => mergeTopicOverrides([entry('a', '1', { readOnly: true })], { a: '2' }), /read-only/);
		assert.throws(() => mergeTopicOverrides([entry('secret', '****', { isSensitive: true })], { b: '1' }), /sensitive/);
	});

	test('describes the diff for confirmation', () => {
		assert.deepStrictEqual(describeChanges(current, { 'retention.ms': '2000', 'cleanup.policy': null, 'new.one': '1' }), [
			'retention.ms: 1000 → 2000', 'cleanup.policy: delete → default', 'new.one: (unset) → 1',
		]);
	});
});

suite('evaluateLag', () => {
	test('notifies once on crossing and clears on recovery', () => {
		const first = evaluateLag([{ key: 'a', lag: 50n, threshold: 10n }, { key: 'b', lag: 5n, threshold: 10n }], new Set());
		assert.deepStrictEqual([...first.over], ['a']);
		assert.deepStrictEqual(first.crossed, ['a']);

		const second = evaluateLag([{ key: 'a', lag: 60n, threshold: 10n }], first.over);
		assert.deepStrictEqual(second.crossed, []);

		const third = evaluateLag([{ key: 'a', lag: 10n, threshold: 10n }], second.over);
		assert.deepStrictEqual(third.recovered, ['a']);
		assert.strictEqual(third.over.size, 0);
	});

	test('a group no longer measured counts as recovered', () => {
		assert.deepStrictEqual(evaluateLag([], new Set(['a'])).recovered, ['a']);
	});
});
