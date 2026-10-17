import * as assert from 'assert';
import { ContextSection, estimateTokens, fitToBudget } from '../ai/budget';

// One token per word: easy to reason about, and not additive across joins like real tokenizers.
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

const sections: ContextSection[] = [
	{ title: 'Cluster', text: 'three brokers healthy', priority: 10 },
	{ title: 'Lag', text: Array.from({ length: 40 }, (_, i) => `p${i}`).join(' '), priority: 5 },
	{ title: 'Configs', text: Array.from({ length: 60 }, (_, i) => `c${i}`).join(' '), priority: 1 },
];

suite('fitToBudget', () => {
	test('keeps everything, in order, when it fits', async () => {
		const result = await fitToBudget(sections, 1000, words);
		assert.deepStrictEqual(result.dropped, []);
		assert.deepStrictEqual(result.truncated, []);
		assert.ok(result.text.indexOf('## Cluster') < result.text.indexOf('## Lag'));
		assert.ok(result.text.indexOf('## Lag') < result.text.indexOf('## Configs'));
	});

	test('cuts the lowest-priority section first', async () => {
		const result = await fitToBudget(sections, 80, words);
		assert.ok(result.tokens <= 80, `${result.tokens} tokens`);
		assert.deepStrictEqual(result.truncated, ['Configs']);
		assert.ok(result.text.includes('p39'), 'higher-priority Lag section kept whole');
		assert.ok(result.text.includes('[truncated]'));
	});

	test('drops a section when too little room is left, then trims the next', async () => {
		const result = await fitToBudget(sections, 35, words);
		assert.ok(result.tokens <= 35, `${result.tokens} tokens`);
		assert.deepStrictEqual(result.dropped, ['Configs']);
		assert.deepStrictEqual(result.truncated, ['Lag']);
		assert.ok(result.text.includes('three brokers healthy'));
	});

	test('never exceeds the budget even when counts are not additive', async () => {
		// Charges one extra token per section boundary only when counting the joined text.
		const count = (text: string) => words(text) + (text.match(/## /g)!.length > 1 ? 10 : 0);
		const result = await fitToBudget(sections, 70, count);
		assert.ok(result.tokens <= 70, `${result.tokens} tokens`);
	});

	test('works with an async counter like model.countTokens', async () => {
		const result = await fitToBudget(sections, 50, async (t) => estimateTokens(t));
		assert.ok(result.tokens <= 50);
		assert.ok(result.text.startsWith('## Cluster'));
	});
});
