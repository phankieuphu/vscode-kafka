import * as assert from 'assert';
import { planReset } from '../kafka/offsets';
import { GroupOffsetEntry } from '../kafka/types';

const entries: GroupOffsetEntry[] = [
	{ topic: 'payments', partition: 1, offset: '300', low: '100', high: '350', lag: '50' },
	{ topic: 'payments', partition: 0, offset: '-1', low: '0', high: '40', lag: '40' },
	{ topic: 'orders', partition: 0, offset: '5', low: '0', high: '10', lag: '5' },
];

suite('planReset', () => {
	test('latest moves every partition of the topic to its end offset', () => {
		const plan = planReset(entries, 'payments', { mode: 'latest' });

		assert.deepStrictEqual(plan.moves, [
			{ partition: 0, from: '-1', to: '40' },
			{ partition: 1, from: '300', to: '350' },
		]);
		assert.strictEqual(plan.lagBefore, '90');
		assert.strictEqual(plan.lagAfter, '0');
	});

	test('earliest moves to the low watermark', () => {
		const plan = planReset(entries, 'payments', { mode: 'earliest' });

		assert.deepStrictEqual(plan.moves.map((m) => m.to), ['0', '100']);
		assert.strictEqual(plan.lagAfter, '290');
	});

	test('shift is relative to the committed offset and clamped to the retained range', () => {
		assert.deepStrictEqual(planReset(entries, 'payments', { mode: 'shift', by: -1000 }).moves.map((m) => m.to), ['0', '100']);
		assert.deepStrictEqual(planReset(entries, 'payments', { mode: 'shift', by: 20 }).moves.map((m) => m.to), ['20', '320']);
		assert.deepStrictEqual(planReset(entries, 'payments', { mode: 'shift', by: 1000 }).moves.map((m) => m.to), ['40', '350']);
	});

	test('ignores other topics', () => {
		assert.deepStrictEqual(planReset(entries, 'missing', { mode: 'latest' }).moves, []);
	});
});
