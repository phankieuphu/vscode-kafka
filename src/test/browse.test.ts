import * as assert from 'assert';
import { matchesSearch, planRanges, widenForSearch } from '../kafka/browse';

const marks = [
	{ partition: 1, low: '100', high: '400' },
	{ partition: 0, low: '0', high: '30' },
	{ partition: 2, low: '50', high: '50' },
];

const plain = (ranges: ReturnType<typeof planRanges>) =>
	ranges.map((r) => [r.partition, Number(r.from), Number(r.to)]);

suite('planRanges', () => {
	test('newest reads the last N per partition and skips empty ones', () => {
		assert.deepStrictEqual(plain(planRanges(marks, { kind: 'newest' }, 50)), [[0, 0, 30], [1, 350, 400]]);
	});

	test('oldest reads from the low watermark', () => {
		assert.deepStrictEqual(plain(planRanges(marks, { kind: 'oldest' }, 50)), [[0, 0, 30], [1, 100, 150]]);
	});

	test('offset is clamped into the retained range', () => {
		assert.deepStrictEqual(plain(planRanges(marks, { kind: 'offset', offset: '120' }, 10, 1)), [[1, 120, 130]]);
		assert.deepStrictEqual(plain(planRanges(marks, { kind: 'offset', offset: '5' }, 10, 1)), [[1, 100, 110]]);
		assert.deepStrictEqual(plain(planRanges(marks, { kind: 'offset', offset: '9999' }, 10, 1)), []);
	});

	test('timestamp starts at the offset the broker found, and nothing when no message is that recent', () => {
		const found = new Map([[0, '-1'], [1, '200']]);
		assert.deepStrictEqual(plain(planRanges(marks, { kind: 'timestamp', timestamp: 1 }, 20, undefined, found)), [[1, 200, 220]]);
	});

	test('pages before and after the offsets already loaded', () => {
		assert.deepStrictEqual(plain(planRanges(marks, { kind: 'before', offsets: { 1: '350' } }, 50)), [[1, 300, 350]]);
		assert.deepStrictEqual(plain(planRanges(marks, { kind: 'before', offsets: { 1: '120' } }, 50)), [[1, 100, 120]]);
		assert.deepStrictEqual(plain(planRanges(marks, { kind: 'after', offsets: { 1: '200' } }, 50)), [[1, 201, 251]]);
		assert.deepStrictEqual(plain(planRanges(marks, { kind: 'after', offsets: { 1: '399' } }, 50)), []);
	});

	test('limits to one partition when asked', () => {
		assert.deepStrictEqual(plain(planRanges(marks, { kind: 'newest' }, 5, 0)), [[0, 25, 30]]);
	});
});

suite('widenForSearch', () => {
	test('scans backwards from the end for newest, forwards otherwise', () => {
		const newest = planRanges(marks, { kind: 'newest' }, 5, 1);
		assert.deepStrictEqual(plain(widenForSearch(newest, marks, 1000, true)), [[1, 100, 400]]);
		const oldest = planRanges(marks, { kind: 'oldest' }, 5, 1);
		assert.deepStrictEqual(plain(widenForSearch(oldest, marks, 100, false)), [[1, 100, 200]]);
	});
});

suite('matchesSearch', () => {
	const message = { key: 'Order-7', value: '{"status":"PAID"}', headers: { trace: 'abc123' } };

	test('matches key, value and header values, ignoring case', () => {
		assert.ok(matchesSearch('order-7', message));
		assert.ok(matchesSearch('paid', message));
		assert.ok(matchesSearch('ABC', message));
		assert.ok(!matchesSearch('refund', message));
		assert.ok(matchesSearch('  ', message));
	});
});
