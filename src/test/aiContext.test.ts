import * as assert from 'assert';
import {
	brokerContext,
	clusterContext,
	clusterSection,
	errorContext,
	findMentioned,
	groupContext,
	messageContext,
	messagesContext,
	resolveChatTarget,
	sampleMessages,
	topicContext,
} from '../ai/context';
import { KAFKA_TOOLS, resolveToolCluster, runTool, ToolEnv, toolSpecs } from '../ai/tools';
import { redactionFor } from '../ai/redact';
import { brokerDetails, cluster, FakeManager, groupDetails, groupOffsets, local, message, overview, SECRETS, secretsIn, topicConfig, topicDetails } from './fixtures/aiFixtures';
import * as fs from 'fs';
import * as path from 'path';

const join = (sections: Array<{ title: string; text: string }>) => sections.map((s) => `## ${s.title}\n${s.text}`).join('\n');

suite('AI context builders', () => {
	test('cluster: name, status and security mode only', () => {
		const text = clusterSection(cluster, 'connected').text;
		assert.match(text, /Name: prod/);
		assert.match(text, /SCRAM-SHA-512/i);
		assert.deepStrictEqual(secretsIn(text), []);
	});

	test('cluster overview: health first, groups by lag, with tables', () => {
		const sections = clusterContext(overview);
		assert.strictEqual(sections[0].title, 'Health');
		assert.match(sections[0].text, /Under-replicated partitions: 1/);
		const groups = sections.find((s) => s.title.startsWith('Consumer groups'))!;
		assert.match(groups.text.split('\n')[0], /orders-consumer.*lag 4500/);
		assert.deepStrictEqual(groups.table!.columns, ['Group', 'State', 'Members', 'Lag']);
		assert.ok(sections.some((s) => s.title === 'Topics with partition problems'));
	});

	test('group: lag per partition most first, with the owning consumer', () => {
		const sections = groupContext(groupDetails, groupOffsets);
		assert.match(sections[0].text, /Total lag: 4500/);
		const lines = sections[1].text.split('\n');
		assert.match(lines[0], /orders\/3: .*lag 4000, consumer orders-app-2/);
		assert.match(sections[1].text, /orders\/5: .*consumer unassigned/);
	});

	test('topic: layout, non-default configs, partitions; risk findings when given', () => {
		const sections = topicContext(topicDetails, topicConfig, [{ level: 'warn', setting: 'retention.ms', text: 'never cleaned' }]);
		assert.match(sections[0].text, /Leaders per broker: 1=5, 2=1/);
		assert.strictEqual(sections[1].title, "Kafka Manager's config checks (rule-based)");
		assert.match(sections[2].text, /retention\.ms=-1 \(set on topic\)/);
		assert.match(sections[3].text, /0: leader 1, replicas \[1,2\], ISR \[1\]/);
	});

	test('broker: role, rack, non-default settings; sensitive values left out', () => {
		const text = join(brokerContext(brokerDetails));
		assert.match(text, /Role: controller/);
		assert.match(text, /auto\.create\.topics\.enable=true/);
		assert.doesNotMatch(text, /ssl\.keystore\.password/);
	});

	test('error: the whole cause chain, security mode and the heuristic hint', () => {
		const fake = new FakeManager();
		const text = join(errorContext(local, fake.getLastError('c2'), fake.getLastErrorChain('c2'), fake.getLastHint('c2')));
		assert.match(text, /KafkaJSNumberOfRetriesExceeded/);
		assert.match(text, /\[ECONNREFUSED\] \(broker localhost:9092\)/);
		assert.match(text, /own guess: Nothing is listening/);
		assert.match(join(errorContext(local, undefined, [], undefined)), /No connection error recorded/);
	});

	test('messages: truncated payloads and an even sample', () => {
		const long = { ...message, value: 'x'.repeat(5000) };
		assert.match(messageContext('orders', long).text, /\[3000 more characters\]/);
		assert.deepStrictEqual(sampleMessages([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3), [1, 4, 7]);
		assert.deepStrictEqual(sampleMessages([1, 2], 5), [1, 2]);
		assert.match(messagesContext('orders', [message, message]).text, /Messages with a key: 2 of 2/);
	});

	test('cluster resolution: named, preferred, the only connected one, or ask', () => {
		const clusters = [cluster, local];
		const status = (id: string): 'connected' | 'disconnected' => (id === 'c1' ? 'connected' : 'disconnected');
		assert.strictEqual(resolveChatTarget('is local ok?', clusters, status).cluster, local);
		assert.strictEqual(resolveChatTarget('is local ok?', clusters, status).rest, 'is ok?');
		assert.strictEqual(resolveChatTarget('health', clusters, status, 'c2').cluster, local);
		assert.strictEqual(resolveChatTarget('health', clusters, status).cluster, cluster);
		assert.strictEqual(resolveChatTarget('health', clusters, () => 'disconnected').cluster, undefined);
		assert.strictEqual(findMentioned('why is `orders-consumer` slow', ['orders', 'orders-consumer']), 'orders-consumer');
	});
});

suite('Kafka LM tools', () => {
	const fake = new FakeManager();
	const env = (payloads = false): ToolEnv => ({
		manager: fake,
		includeMessagePayloads: payloads,
		redaction: async (clusters) => redactionFor(clusters, [SECRETS.saslPassword, SECRETS.registryPassword, SECRETS.aiKey], false),
	});
	const never = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

	test('only connected clusters; never connects; names the problem', () => {
		const status = (id: string) => fake.getStatus(id);
		assert.strictEqual(resolveToolCluster(fake.clusters, status, undefined), cluster);
		assert.strictEqual(resolveToolCluster(fake.clusters, status, 'PROD'), cluster);
		assert.throws(() => resolveToolCluster(fake.clusters, status, 'local'), /disconnected, not connected.*never connect/);
		assert.throws(() => resolveToolCluster(fake.clusters, status, 'nope'), /No cluster named "nope". Known clusters: prod, local/);
		assert.throws(() => resolveToolCluster([], status, undefined), /No Kafka clusters/);
		assert.throws(() => resolveToolCluster(fake.clusters, () => 'connected', undefined), /Several clusters/);
	});

	test('input validation errors come back as text for the model', async () => {
		assert.match(await runTool(env(), 'kafka_describeTopic', {}, never), /^Error: Missing "topic"/);
		assert.match(await runTool(env(), 'kafka_describeBroker', { brokerId: 'x' }, never), /^Error: "brokerId" must be a whole number/);
		assert.match(await runTool(env(), 'kafka_nope', {}, never), /unknown tool/);
	});

	test('every tool result is redacted', async () => {
		for (const tool of KAFKA_TOOLS) {
			const input = { cluster: 'prod', topic: 'orders', group: 'orders-consumer', brokerId: 1 };
			const text = await runTool(env(true), tool.name, tool.name === 'kafka_connectionError' ? { cluster: 'local' } : input, never);
			assert.deepStrictEqual(secretsIn(text), [], `${tool.name} leaked`);
			assert.doesNotMatch(text, /^Error/, `${tool.name}: ${text}`);
		}
	});

	test('message contents only with kafka.ai.includeMessagePayloads', async () => {
		assert.match(await runTool(env(false), 'kafka_peekMessages', { topic: 'orders' }, never), /not shared with AI.*includeMessagePayloads/);
		assert.ok(!toolSpecs(false).some((t) => t.name === 'kafka_peekMessages'));
		assert.ok(toolSpecs(true).some((t) => t.name === 'kafka_peekMessages'));
		const text = await runTool(env(true), 'kafka_peekMessages', { topic: 'orders', count: 50 }, never);
		assert.match(text, /order-42/);
		assert.deepStrictEqual(secretsIn(text), []);
	});

	test('package.json languageModelTools match the tool definitions, and none mutates', () => {
		const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
		const contributed = manifest.contributes.languageModelTools as Array<any>;
		assert.deepStrictEqual(contributed.map((t) => t.name), KAFKA_TOOLS.map((t) => t.name));
		for (const tool of KAFKA_TOOLS) {
			const entry = contributed.find((t) => t.name === tool.name);
			assert.deepStrictEqual(entry.inputSchema, tool.inputSchema, tool.name);
			assert.strictEqual(entry.modelDescription, tool.modelDescription);
			assert.strictEqual(entry.toolReferenceName, tool.name);
			assert.strictEqual(entry.canBeReferencedInPrompt, true);
			assert.ok(entry.tags.includes('read-only'));
			assert.doesNotMatch(tool.name, /create|delete|reset|produce|alter|update/i);
		}
	});
});
