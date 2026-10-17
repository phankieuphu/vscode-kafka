import * as assert from 'assert';
import { runAgent, toolProgress } from '../ai/agent';
import { AiModel, AiProviderError, AiRequest, AiStreamEvent, CancellationLike } from '../ai/providers/types';

/** A model that replays scripted rounds and records what it was sent. */
function scripted(rounds: Array<AiStreamEvent[] | Error>): AiModel & { seen: AiRequest[] } {
	const seen: AiRequest[] = [];
	return {
		id: 'fake', name: 'Fake', provider: 'test', providerLabel: 'Test', maxInputTokens: 10000,
		countTokens: async (t) => Math.ceil(t.length / 4),
		seen,
		async *stream(request) {
			seen.push(JSON.parse(JSON.stringify(request)));
			const round = rounds[seen.length - 1] ?? [{ type: 'text', text: 'done' }];
			if (round instanceof Error) {
				throw round;
			}
			yield* round;
		},
	};
}

const live: CancellationLike = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const out = () => {
	const o = { text: '', progress: [] as string[], write(t: string) { o.text += t; }, progressFn(t: string) { o.progress.push(t); } };
	return { o, output: { write: (t: string) => o.write(t), progress: (t: string) => o.progressFn(t) } };
};
const request: AiRequest = {
	system: 's',
	messages: [{ role: 'user', parts: [{ type: 'text', text: 'why lag?' }] }],
	tools: [{ name: 'kafka_describeConsumerGroup', description: 'd', inputSchema: { type: 'object', properties: {} } }],
};

suite('Agent loop', () => {
	test('runs requested tools, sends results back, and streams the final answer', async () => {
		const model = scripted([
			[{ type: 'text', text: 'Let me look.' }, { type: 'toolCall', id: 'c1', name: 'kafka_describeConsumerGroup', input: { group: 'g' } }],
			[{ type: 'text', text: 'Partition 3 is stuck.' }],
		]);
		const ran: string[] = [];
		const { o, output } = out();
		const result = await runAgent(model, request, async (name, input) => { ran.push(`${name}:${JSON.stringify(input)}`); return 'lag on p3'; }, output, live);
		assert.deepStrictEqual(ran, ['kafka_describeConsumerGroup:{"group":"g"}']);
		assert.match(o.text, /Let me look\.\n\nPartition 3 is stuck\./);
		assert.deepStrictEqual(o.progress, ['Running describe consumer group (g)…']);
		const second = model.seen[1].messages;
		assert.deepStrictEqual(second[1].parts[1], { type: 'toolCall', id: 'c1', name: 'kafka_describeConsumerGroup', input: { group: 'g' } });
		assert.deepStrictEqual(second[2], { role: 'user', parts: [{ type: 'toolResult', id: 'c1', name: 'kafka_describeConsumerGroup', content: 'lag on p3' }] });
		assert.strictEqual(result.toolCalls.length, 1);
	});

	test('stops offering tools after the last round so the model must answer', async () => {
		const call: AiStreamEvent = { type: 'toolCall', id: 'x', name: 'kafka_describeConsumerGroup', input: {} };
		const model = scripted([[call], [call], [{ type: 'text', text: 'final' }]]);
		const { o, output } = out();
		await runAgent(model, request, async () => 'r', output, live, 2);
		assert.ok(model.seen[0].tools && model.seen[1].tools);
		assert.strictEqual(model.seen[2].tools, undefined);
		assert.match(o.text, /final/);
	});

	test('retries without tools when the model rejects tool definitions', async () => {
		const model = scripted([new AiProviderError('tools not supported', 'badRequest', 400), [{ type: 'text', text: 'plain answer' }]]);
		const { o, output } = out();
		const result = await runAgent(model, request, async () => 'r', output, live);
		assert.strictEqual(model.seen[1].tools, undefined);
		assert.strictEqual(result.error, undefined);
		assert.match(o.text, /plain answer/);
	});

	test('reports other failures once, readable', async () => {
		const model = scripted([new AiProviderError('Anthropic rejected the API key.', 'auth', 401)]);
		const { o, output } = out();
		const result = await runAgent(model, request, async () => 'r', output, live);
		assert.strictEqual(result.error, 'Anthropic rejected the API key.');
		assert.match(o.text, /Couldn't get an answer.*rejected the API key/);
	});

	test('progress text names the subject', () => {
		assert.strictEqual(toolProgress('kafka_describeTopic', { topic: 'orders' }), 'Running describe topic (orders)…');
		assert.strictEqual(toolProgress('kafka_listClusters', {}), 'Running list clusters…');
	});
});
