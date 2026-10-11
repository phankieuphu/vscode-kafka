import * as assert from 'assert';
import { buildClusterOverview } from '../kafka/dashboard';
import { partitionLag } from '../kafka/lag';
import { planReset } from '../kafka/offsets';

suite('partitionLag', () => {
	test('is high minus the committed offset', () => {
		assert.strictEqual(partitionLag('90', '0', '100'), 10n);
		assert.strictEqual(partitionLag('100', '0', '100'), 0n);
	});

	test('counts only retained messages when nothing is committed', () => {
		// Retention deleted 0..999 999; only 1 000 messages are left to read.
		assert.strictEqual(partitionLag('-1', '999000', '1000000'), 1000n);
		assert.strictEqual(partitionLag('-1', '0', '0'), 0n);
	});

	test('is never more than what is retained when the commit fell behind retention', () => {
		assert.strictEqual(partitionLag('5', '500', '600'), 100n);
	});

	test('is never negative after the topic was truncated or recreated', () => {
		assert.strictEqual(partitionLag('700', '0', '50'), 0n);
	});

	test('stays exact beyond Number.MAX_SAFE_INTEGER', () => {
		assert.strictEqual(partitionLag('1', '0', '18014398509481985'), 18014398509481984n);
	});
});

suite('lag across views', () => {
	const offsets = [
		{ topic: 'events', partition: 0, offset: '-1', low: '900', high: '1000', lag: '' },
		{ topic: 'events', partition: 1, offset: '80', low: '0', high: '50', lag: '' },
	];

	test('planReset uses the same lag as the dashboard', () => {
		const plan = planReset(offsets, 'events', { mode: 'latest' });
		const overview = buildClusterOverview({
			clusterId: 'c', controllerId: 1, brokers: [],
			topics: [{ name: 'events', partitions: [] }],
			watermarks: new Map([['events', [
				{ partition: 0, low: '900', high: '1000' },
				{ partition: 1, low: '0', high: '50' },
			]]]),
			groups: [{ groupId: 'g', state: 'Empty', memberCount: 0, offsets: [{ topic: 'events', partitions: offsets }] }],
		});

		assert.strictEqual(plan.lagBefore, '100');
		assert.strictEqual(overview.groups[0].totalLag, '100');
	});
});
