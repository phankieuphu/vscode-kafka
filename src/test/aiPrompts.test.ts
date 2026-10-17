/**
 * Prompt regression harness: builds every prompt from recorded ClusterManager
 * outputs and checks structure and redaction. No model is called.
 */
import * as assert from 'assert';
import { AssistantDeps, actionsFor, prepareAssistant } from '../ai/assistant';
import { fromChatRequest } from '../ai/chat';
import { messageContext, messagesContext } from '../ai/context';
import { AiTask, buildRequest, INSTRUCTIONS, TASKS } from '../ai/prompts';
import { messageText } from '../ai/providers/types';
import { estimateTokens } from '../ai/budget';
import { cluster, FakeManager, message, SECRETS, secretsIn, undecodable } from './fixtures/aiFixtures';

const never = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const model = { maxInputTokens: 100_000, countTokens: async (t: string) => estimateTokens(t) };

function deps(manager = new FakeManager(), over: Partial<AssistantDeps> = {}): AssistantDeps {
	return { manager, includeMessagePayloads: true, maskHosts: false, aiKeys: [SECRETS.aiKey], ...over };
}

/** Every task with what it needs, as the UI sends it. */
const CASES: Array<{ task: AiTask; prompt?: string; clusterId?: string; target?: object; extra?: () => any[]; expect: RegExp[] }> = [
	{ task: 'ask', prompt: 'is prod healthy?', expect: [/## Health/, /is healthy\?/] },
	{ task: 'diagnose', clusterId: 'c1', expect: [/## Health/, /Consumer groups \(most lag first\)/] },
	{ task: 'lag', prompt: 'orders-consumer', clusterId: 'c1', expect: [/Consumer group orders-consumer/, /orders\/3: .*lag 4000/] },
	{ task: 'lag', clusterId: 'c1', expect: [/Consumer group orders-consumer/] },
	{ task: 'explain-error', clusterId: 'c2', expect: [/Last connection error/, /ECONNREFUSED/, /own guess/] },
	{ task: 'topic', clusterId: 'c1', target: { topic: 'orders' }, expect: [/## Topic orders/, /config checks \(rule-based\)/] },
	{ task: 'topic-config', clusterId: 'c1', target: { topic: 'orders', keysSeen: true }, expect: [/retention\.ms=-1/, /never cleaned up/] },
	{ task: 'broker-config', clusterId: 'c1', target: { brokerId: 1 }, expect: [/## Broker 1/, /auto\.create\.topics\.enable/, /default\.replication\.factor=1/] },
	{ task: 'explain-message', clusterId: 'c1', target: { topic: 'orders' }, extra: () => [messageContext('orders', message)], expect: [/order-42/, /"total":9\.5/] },
	{ task: 'explain-decode-error', clusterId: 'c1', target: { topic: 'orders' }, extra: () => [messageContext('orders', undecodable)], expect: [/Decode error: Expected JSON/, /magic byte/] },
	{ task: 'infer-schema', clusterId: 'c1', target: { topic: 'orders' }, extra: () => [messagesContext('orders', [message, undecodable])], expect: [/sampled message/] },
	{ task: 'dashboard-summary', clusterId: 'c1', expect: [/## Health/] },
	{ task: 'lag-alert', clusterId: 'c1', target: { group: 'orders-consumer' }, extra: () => [{ title: "Kafka Manager's lag analysis (rule-based)", priority: 95, text: '- Trend: growing' }], expect: [/Trend: growing/, /orders\/3/] },
];

suite('Prompt regression (no model)', () => {
	for (const c of CASES) {
		test(`${c.task}${c.prompt ? ` "${c.prompt}"` : ''}: structure and redaction`, async () => {
			const prepared = await prepareAssistant(deps(), model, { task: c.task, prompt: c.prompt ?? '', clusterId: c.clusterId, target: c.target, extraSections: c.extra?.() }, never);
			assert.ok(prepared.ok, !prepared.ok ? prepared.message : '');
			if (!prepared.ok) {
				return;
			}
			const { request } = prepared.built;
			assert.ok(request.system.startsWith(INSTRUCTIONS));
			assert.ok(request.system.endsWith(`Task: ${TASKS[prepared.meta.task]}`));
			const last = messageText(request.messages[request.messages.length - 1]);
			assert.match(last, /^# Context\n\n## Cluster\n/);
			assert.match(last, /\n# Question\n\n/);
			for (const re of c.expect) {
				assert.match(last, re);
			}
			const everything = JSON.stringify(request) + JSON.stringify(prepared.built.sections);
			assert.deepStrictEqual(secretsIn(everything), [], 'a secret reached the prompt');
			assert.doesNotMatch(everything, /hunter2|sasl\.jaas\.config=org/);
			assert.strictEqual(request.tools !== undefined, c.task === 'ask', 'tools only for free-form questions');
		});
	}

	test('masked hosts: broker and registry hostnames never appear', async () => {
		const prepared = await prepareAssistant(deps(undefined, { maskHosts: true }), model, { task: 'diagnose', prompt: '', clusterId: 'c1' }, never);
		assert.ok(prepared.ok);
		if (prepared.ok) {
			const text = JSON.stringify(prepared.built.request);
			assert.doesNotMatch(text, /kafka\.example\.com|registry\.example\.com/);
			assert.match(text, /host-1/);
		}
	});

	test('a disconnected cluster asks to connect; one in error explains the error instead', async () => {
		const manager = new FakeManager();
		const off = await prepareAssistant(deps(manager), model, { task: 'diagnose', prompt: '', clusterId: 'c2' }, never);
		assert.ok(!off.ok && /isn't connected/.test(off.message) && off.actions[0].command === 'kafka-manager.connectCluster');
		manager.statuses.c2 = 'error';
		const err = await prepareAssistant(deps(manager), model, { task: 'diagnose', prompt: '', clusterId: 'c2' }, never);
		assert.ok(err.ok && err.meta.task === 'explain-error');
	});

	test('no clusters: offers Add Cluster', async () => {
		const manager = new FakeManager();
		manager.clusters = [];
		const r = await prepareAssistant(deps(manager), model, { task: 'ask', prompt: 'hi' }, never);
		assert.ok(!r.ok && r.actions[0].command === 'kafka-manager.addCluster');
	});

	test('the budget keeps the most important sections', async () => {
		const tiny = { maxInputTokens: 2400, countTokens: async (t: string) => estimateTokens(t) };
		const prepared = await prepareAssistant(deps(), tiny, { task: 'topic', prompt: '', clusterId: 'c1', target: { topic: 'orders' } }, never);
		assert.ok(prepared.ok);
		if (prepared.ok) {
			const last = messageText(prepared.built.request.messages[0]);
			assert.match(last, /## Cluster/);
			assert.match(last, /## Topic orders/);
		}
	});

	test('history is redacted and kept short', async () => {
		const history = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', parts: [{ type: 'text' as const, text: `turn ${i} ${SECRETS.saslPassword}` }] }));
		const built = await buildRequest({ task: 'ask', sections: [], question: 'q', history, redaction: { secrets: [SECRETS.saslPassword] }, budget: 1000, count: estimateTokens });
		assert.strictEqual(built.request.messages.length, 7);
		assert.deepStrictEqual(secretsIn(JSON.stringify(built.request)), []);
	});

	test('the Chat view and the panel send identical model messages for the same request', async () => {
		const history = [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'earlier' }] }, { role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'answer' }] }];
		for (const [command, task] of [[undefined, 'ask'], ['diagnose', 'diagnose'], ['lag', 'lag'], ['topic', 'topic']] as const) {
			const prompt = command === 'topic' ? 'orders' : 'orders-consumer';
			const fromChat = await prepareAssistant(deps(), model, fromChatRequest(prompt, command, history, 'c1'), never);
			// What the Kafka AI panel sends for the same text and chip (src/panels/aiChatPanel.ts).
			const fromPanel = await prepareAssistant(deps(), model, { task, prompt, clusterId: 'c1', history }, never);
			assert.ok(fromChat.ok && fromPanel.ok);
			if (fromChat.ok && fromPanel.ok) {
				assert.deepStrictEqual(fromChat.built.request, fromPanel.built.request, `${task} differs`);
			}
		}
	});

	test('actions only link to existing read/navigate commands', () => {
		for (const task of Object.keys(TASKS) as AiTask[]) {
			for (const action of actionsFor({ task, cluster, group: 'g', topic: 't', brokerId: 1, notes: [] })) {
				assert.match(action.command, /^kafka-manager\.(editClusterSecurity|reconnectCluster|viewConsumerGroup|resetGroupOffsets|watchGroupLag|viewTopic|viewBroker|openDashboard)$/);
			}
		}
	});
});
