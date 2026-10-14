import * as assert from 'assert';
import { anthropicBody, AnthropicStreamDecoder } from '../ai/providers/anthropic';
import { getProvider, keyMismatch, pickDefaultModel, PROVIDERS, validateBaseUrl, chatModels } from '../ai/providers/catalog';
import { geminiBody, GeminiStreamDecoder, geminiSchema } from '../ai/providers/gemini';
import { httpError, retryAfterMs, setFetch, setRetryDelays, FetchLike } from '../ai/providers/http';
import { createHttpModel } from '../ai/providers/httpModel';
import { openAiBody, openAiHeaders, OpenAiStreamDecoder } from '../ai/providers/openai';
import { parseSse } from '../ai/providers/sse';
import { AiRequest, AiStreamEvent, NEVER_CANCELLED } from '../ai/providers/types';

async function* chunks(...parts: string[]) {
	const encoder = new TextEncoder();
	for (const p of parts) {
		yield encoder.encode(p);
	}
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of it) {
		out.push(x);
	}
	return out;
}

const toolRequest: AiRequest = {
	system: 'Be brief.',
	messages: [
		{ role: 'user', parts: [{ type: 'text', text: 'Why lag?' }] },
		{ role: 'assistant', parts: [{ type: 'text', text: 'Checking.' }, { type: 'toolCall', id: 't1', name: 'kafka_describeConsumerGroup', input: { group: 'g' }, signature: 'sig' }] },
		{ role: 'user', parts: [{ type: 'toolResult', id: 't1', name: 'kafka_describeConsumerGroup', content: 'lag 5' }] },
	],
	tools: [{ name: 'kafka_describeConsumerGroup', description: 'Describe', inputSchema: { type: 'object', properties: { group: { type: 'string', description: 'id' } }, required: ['group'] } }],
	maxOutputTokens: 500,
};

suite('SSE parser', () => {
	test('handles split chunks, CRLF, multi-line data, comments and a missing final newline', async () => {
		const events = await collect(parseSse(chunks(': ping\r\n', 'event: a\r\nda', 'ta: 1\r\ndata: 2\r\n\r', '\ndata: {"x":', '1}\n\ndata: last')));
		assert.deepStrictEqual(events, [
			{ event: 'a', data: '1\n2' },
			{ event: undefined, data: '{"x":1}' },
			{ event: undefined, data: 'last' },
		]);
	});

	test('decodes UTF-8 split across chunks', async () => {
		const bytes = new TextEncoder().encode('data: héllo ✓\n\n');
		async function* split() { yield bytes.slice(0, 8); yield bytes.slice(8); }
		assert.deepStrictEqual(await collect(parseSse(split())), [{ event: undefined, data: 'héllo ✓' }]);
	});
});

suite('Anthropic adapter', () => {
	test('request body: system prompt, tool_use/tool_result blocks, tools', () => {
		const body = anthropicBody('claude-x', toolRequest) as any;
		assert.strictEqual(body.system, 'Be brief.');
		assert.strictEqual(body.max_tokens, 500);
		assert.strictEqual(body.stream, true);
		assert.deepStrictEqual(body.messages[1].content[1], { type: 'tool_use', id: 't1', name: 'kafka_describeConsumerGroup', input: { group: 'g' } });
		assert.deepStrictEqual(body.messages[2].content[0], { type: 'tool_result', tool_use_id: 't1', content: 'lag 5' });
		assert.strictEqual(body.tools[0].input_schema.required[0], 'group');
	});

	test('stream: text deltas and a tool call assembled from partial JSON', () => {
		const d = new AnthropicStreamDecoder();
		const events: AiStreamEvent[] = [
			...d.push('content_block_start', '{"index":0,"content_block":{"type":"text","text":""}}'),
			...d.push('content_block_delta', '{"index":0,"delta":{"type":"text_delta","text":"Hi"}}'),
			...d.push('content_block_start', '{"index":1,"content_block":{"type":"tool_use","id":"tu","name":"kafka_listTopics"}}'),
			...d.push('content_block_delta', '{"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"filter\\":"}}'),
			...d.push('content_block_delta', '{"index":1,"delta":{"type":"input_json_delta","partial_json":"\\"ord\\"}"}}'),
			...d.push('content_block_stop', '{"index":1}'),
			...d.push('message_stop', '{}'),
		];
		assert.deepStrictEqual(events, [
			{ type: 'text', text: 'Hi' },
			{ type: 'toolCall', id: 'tu', name: 'kafka_listTopics', input: { filter: 'ord' } },
		]);
	});

	test('stream error events throw', () => {
		assert.throws(() => new AnthropicStreamDecoder().push('error', '{"error":{"type":"overloaded_error","message":"Overloaded"}}'), /Overloaded/);
	});
});

suite('OpenAI-compatible adapter', () => {
	test('request body: system message, tool_calls and tool messages', () => {
		const body = openAiBody('gpt-x', toolRequest) as any;
		assert.deepStrictEqual(body.messages[0], { role: 'system', content: 'Be brief.' });
		assert.deepStrictEqual(body.messages[2].tool_calls[0], { id: 't1', type: 'function', function: { name: 'kafka_describeConsumerGroup', arguments: '{"group":"g"}' } });
		assert.deepStrictEqual(body.messages[3], { role: 'tool', tool_call_id: 't1', content: 'lag 5' });
		assert.strictEqual(body.tools[0].function.parameters.properties.group.type, 'string');
	});

	test('headers: Bearer, Azure api-key, OpenRouter attribution, none for local', () => {
		assert.strictEqual(openAiHeaders(getProvider('openai')!, 'k').authorization, 'Bearer k');
		assert.deepStrictEqual(openAiHeaders(getProvider('azureOpenai')!, 'k'), { 'api-key': 'k' });
		assert.ok(openAiHeaders(getProvider('openrouter')!, 'k')['X-Title']);
		assert.deepStrictEqual(openAiHeaders(getProvider('ollama')!, undefined), {});
	});

	test('stream: text and tool calls accumulated by index, flushed on finish', () => {
		const d = new OpenAiStreamDecoder();
		const events = [
			...d.push('{"choices":[{"delta":{"content":"A"}}]}'),
			...d.push('{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"kafka_listTopics","arguments":"{\\"fil"}}]}}]}'),
			...d.push('{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ter\\":\\"x\\"}"}}]}}]}'),
			...d.push('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'),
			...d.push('[DONE]'),
		];
		assert.deepStrictEqual(events, [
			{ type: 'text', text: 'A' },
			{ type: 'toolCall', id: 'c1', name: 'kafka_listTopics', input: { filter: 'x' } },
		]);
	});
});

suite('Gemini adapter', () => {
	test('request body: systemInstruction, model role, function call with thought signature, function response', () => {
		const body = geminiBody(toolRequest) as any;
		assert.strictEqual(body.systemInstruction.parts[0].text, 'Be brief.');
		assert.strictEqual(body.contents[1].role, 'model');
		assert.deepStrictEqual(body.contents[1].parts[1], { functionCall: { name: 'kafka_describeConsumerGroup', args: { group: 'g' } }, thoughtSignature: 'sig' });
		assert.deepStrictEqual(body.contents[2].parts[0], { functionResponse: { name: 'kafka_describeConsumerGroup', response: { content: 'lag 5' } } });
		assert.strictEqual(body.generationConfig.maxOutputTokens, 500);
	});

	test('tool schemas keep only what Gemini accepts; tools without inputs have no parameters', () => {
		assert.deepStrictEqual(geminiSchema({ type: 'object', properties: { a: { type: 'integer', description: 'd' } } }), { type: 'object', properties: { a: { type: 'integer', description: 'd' } } });
		const body = geminiBody({ ...toolRequest, tools: [{ name: 'x', description: 'y', inputSchema: { type: 'object', properties: {} } }] }) as any;
		assert.strictEqual(body.tools[0].functionDeclarations[0].parameters, undefined);
	});

	test('stream: skips thoughts, keeps text and signed function calls; blocked prompts throw', () => {
		const d = new GeminiStreamDecoder();
		const events = d.push(JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'hmm' }, { text: 'Hi' }, { functionCall: { name: 'f', args: { a: 1 } }, thoughtSignature: 'S' }] } }] }));
		assert.deepStrictEqual(events, [
			{ type: 'text', text: 'Hi' },
			{ type: 'toolCall', id: 'gemini-call-1', name: 'f', input: { a: 1 }, signature: 'S' },
		]);
		assert.throws(() => d.push('{"promptFeedback":{"blockReason":"SAFETY"}}'), /blocked/);
	});
});

suite('Provider catalog', () => {
	test('every provider has a label and a kind; ids are unique', () => {
		const ids = PROVIDERS.map((p) => p.id);
		assert.strictEqual(new Set(ids).size, ids.length);
		assert.ok(PROVIDERS.every((p) => p.label && p.kind));
		for (const id of ['anthropic', 'openai', 'gemini', 'openrouter', 'vscode', 'ollama']) {
			assert.ok(getProvider(id), id);
		}
	});

	test('picks a sensible default from a live model list', () => {
		assert.strictEqual(pickDefaultModel(getProvider('anthropic')!, [{ id: 'claude-haiku-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-sonnet-4-5-20250929' }, { id: 'claude-opus-5-5' }]), 'claude-sonnet-5-5');
		assert.strictEqual(
			pickDefaultModel(getProvider('openai')!, [
				{ id: 'text-embedding-3-large', created: 9 }, { id: 'gpt-5.5', created: 5 }, { id: 'gpt-5.5-mini', created: 6 }, { id: 'gpt-5.6-sol', created: 7 }, { id: 'gpt-4o-realtime-preview', created: 8 }, { id: 'gpt-5.4', created: 4 },
			]),
			'gpt-5.6-sol',
		);
		assert.strictEqual(pickDefaultModel(getProvider('gemini')!, [{ id: 'gemini-3.8-pro' }, { id: 'gemini-3.8-flash' }, { id: 'gemini-3.7-flash' }, { id: 'gemini-3.8-flash-lite' }, { id: 'text-embedding-004' }]), 'gemini-3.8-flash');
		assert.strictEqual(pickDefaultModel(getProvider('ollama')!, [{ id: 'llama3.2:latest' }]), 'llama3.2:latest');
		assert.strictEqual(pickDefaultModel(getProvider('openai')!, []), undefined);
	});

	test('chat model lists drop embeddings, speech and images', () => {
		const list = chatModels(getProvider('openai')!, [{ id: 'gpt-5.5' }, { id: 'whisper-1' }, { id: 'tts-1' }, { id: 'dall-e-3' }, { id: 'omni-moderation-latest' }, { id: 'o4-mini' }]);
		assert.deepStrictEqual(list.map((m) => m.id).sort(), ['gpt-5.5', 'o4-mini']);
	});

	test('base URLs: https anywhere, plain http only to this machine', () => {
		assert.strictEqual(validateBaseUrl('https://gw.example.com/v1'), undefined);
		assert.strictEqual(validateBaseUrl('http://localhost:11434/v1'), undefined);
		assert.strictEqual(validateBaseUrl('http://127.0.0.1:1234/v1'), undefined);
		assert.match(validateBaseUrl('http://gw.example.com/v1')!, /https/);
		assert.match(validateBaseUrl('ftp://x')!, /https/);
		assert.match(validateBaseUrl('not a url')!, /full URL/);
	});

	test('catches a key pasted into the wrong provider', () => {
		assert.match(keyMismatch(getProvider('openai')!, 'sk-ant-api03-xxxx')!, /Anthropic/);
		assert.match(keyMismatch(getProvider('anthropic')!, 'AIzaSyXXXX')!, /Gemini/);
		assert.strictEqual(keyMismatch(getProvider('anthropic')!, 'sk-ant-api03-xxxx'), undefined);
		assert.strictEqual(keyMismatch(getProvider('openrouter')!, 'sk-or-v1-xxxx'), undefined);
		assert.match(keyMismatch(getProvider('openai')!, 'sk-a b')!, /spaces/);
	});
});

suite('HTTP errors', () => {
	test('turn status codes into actionable messages with the provider\'s own text', () => {
		const e401 = httpError(401, 'Unauthorized', '{"error":{"message":"invalid x-api-key"}}', 'Anthropic');
		assert.strictEqual(e401.kind, 'auth');
		assert.match(e401.message, /Set AI API Key.*invalid x-api-key/);
		assert.strictEqual(httpError(429, '', '', 'OpenAI').kind, 'rateLimit');
		assert.strictEqual(httpError(404, '', '[{"error":{"message":"models/x is not found"}}]', 'Gemini').kind, 'notFound');
		assert.strictEqual(httpError(400, '', '{"error":"bad"}', 'Ollama').kind, 'badRequest');
		assert.strictEqual(httpError(503, '', '<html>', 'X').kind, 'server');
	});
});

suite('HTTP models end to end (fake fetch)', () => {
	let requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
	const respond = (sse: string, status = 200): FetchLike => async (url, init) => {
		requests.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
		return { ok: status < 300, status, statusText: '', text: async () => sse, body: chunks(sse) };
	};
	teardown(() => {
		setFetch(undefined);
		requests = [];
	});

	test('Anthropic: URL, headers and streamed text', async () => {
		setFetch(respond('event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'));
		const model = createHttpModel({ provider: getProvider('anthropic')!, key: 'sk-ant-k', model: 'claude-x' });
		const events = await collect(model.stream({ system: 's', messages: [{ role: 'user', parts: [{ type: 'text', text: 'q' }] }] }, NEVER_CANCELLED));
		assert.deepStrictEqual(events, [{ type: 'text', text: 'ok' }]);
		assert.strictEqual(requests[0].url, 'https://api.anthropic.com/v1/messages');
		assert.strictEqual(requests[0].headers['x-api-key'], 'sk-ant-k');
		assert.strictEqual(requests[0].headers['anthropic-version'], '2023-06-01');
	});

	test('OpenAI-compatible: base URL override and trailing slash', async () => {
		setFetch(respond('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'));
		const model = createHttpModel({ provider: getProvider('ollama')!, baseUrl: 'http://localhost:11434/v1/', model: 'llama3.2' });
		const events = await collect(model.stream({ system: 's', messages: [] }, NEVER_CANCELLED));
		assert.deepStrictEqual(events, [{ type: 'text', text: 'hi' }]);
		assert.strictEqual(requests[0].url, 'http://localhost:11434/v1/chat/completions');
		assert.strictEqual(requests[0].headers.authorization, undefined);
	});

	test('Gemini: model path and key header', async () => {
		setFetch(respond('data: {"candidates":[{"content":{"parts":[{"text":"g"}]}}]}\n\n'));
		const model = createHttpModel({ provider: getProvider('gemini')!, key: 'AIzaK', model: 'gemini-3.8-flash' });
		await collect(model.stream({ system: 's', messages: [] }, NEVER_CANCELLED));
		assert.strictEqual(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
		assert.strictEqual(requests[0].headers['x-goog-api-key'], 'AIzaK');
	});

	test('a rejected key surfaces as an auth error', async () => {
		setFetch(respond('{"error":{"message":"Incorrect API key"}}', 401));
		const model = createHttpModel({ provider: getProvider('openai')!, key: 'sk-bad', model: 'gpt-x' });
		await assert.rejects(collect(model.stream({ system: 's', messages: [] }, NEVER_CANCELLED)), (e: any) => e.kind === 'auth' && /Incorrect API key/.test(e.message));
	});
});

suite('Retries on transient provider errors', () => {
	const GEMINI_503 = '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}';
	const OK = 'data: {"candidates":[{"content":{"parts":[{"text":"recovered"}]}}]}\n\n';
	let calls = 0;
	/** Answers with each status in turn, then 200. */
	const sequence = (statuses: number[]): FetchLike => async () => {
		const status = statuses[calls++] ?? 200;
		const text = status === 200 ? OK : status === 401 ? '{"error":{"message":"API key not valid"}}' : GEMINI_503;
		return { ok: status < 300, status, statusText: '', text: async () => text, body: chunks(text), headers: { get: () => null } };
	};
	const gemini = () => createHttpModel({ provider: getProvider('gemini')!, key: 'AIzaK', model: 'gemini-3.8-flash' });
	setup(() => {
		calls = 0;
		setRetryDelays([0, 0, 0]);
	});
	teardown(() => {
		setFetch(undefined);
		setRetryDelays([1000, 3000, 7000]);
	});

	test('a 503 "high demand" that clears up is retried and the answer arrives', async () => {
		setFetch(sequence([503, 503]));
		const events = await collect(gemini().stream({ system: 's', messages: [] }, NEVER_CANCELLED));
		assert.deepStrictEqual(events, [{ type: 'text', text: 'recovered' }]);
		assert.strictEqual(calls, 3);
	});

	test('still overloaded after every retry: says so, with the provider text and what to do', async () => {
		setFetch(sequence([503, 503, 503, 503, 503]));
		await assert.rejects(collect(gemini().stream({ system: 's', messages: [] }, NEVER_CANCELLED)), (e: any) => {
			assert.strictEqual(e.kind, 'server');
			assert.match(e.message, /Google Gemini is overloaded right now \(503\), even after 4 tries/);
			assert.match(e.message, /Select AI Model/);
			assert.match(e.message, /high demand/);
			return true;
		});
		assert.strictEqual(calls, 4);
	});

	test('errors that retrying cannot fix are not retried', async () => {
		setFetch(sequence([401]));
		await assert.rejects(collect(gemini().stream({ system: 's', messages: [] }, NEVER_CANCELLED)), (e: any) => e.kind === 'auth');
		assert.strictEqual(calls, 1);
	});

	test('cancelling while waiting stops the retries', async () => {
		setRetryDelays([60_000]);
		setFetch(sequence([503]));
		let cancel: () => void = () => undefined;
		const token = { isCancellationRequested: false, onCancellationRequested: (l: () => void) => { cancel = () => { token.isCancellationRequested = true; l(); }; return { dispose() {} }; } };
		const pending = collect(gemini().stream({ system: 's', messages: [] }, token));
		setTimeout(() => cancel(), 20);
		await assert.rejects(pending, (e: any) => e.kind === 'cancelled');
		assert.strictEqual(calls, 1);
	});

	test('Retry-After in seconds or as a date; too long or invalid is ignored', () => {
		assert.strictEqual(retryAfterMs('2'), 2000);
		assert.strictEqual(retryAfterMs(null), undefined);
		assert.strictEqual(retryAfterMs('3600'), undefined);
		assert.strictEqual(retryAfterMs('soon'), undefined);
		const at = retryAfterMs(new Date(Date.now() + 5000).toUTCString())!;
		assert.ok(at > 3000 && at <= 5000);
	});
});
