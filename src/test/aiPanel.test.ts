import * as assert from 'assert';
import * as crypto from 'crypto';
import { CHIPS, parsePanelMessage, toBlocks } from '../ai/chatPanelProtocol';
import { chatViewQuery } from '../ai/open';
import { createPkce, maskKey, openRouterAuthUrl } from '../ai/keys';
import { renderMarkdown } from '../ai/markdown';
import { redactSection } from '../ai/prompts';
import { redactionFor } from '../ai/redact';
import { groupContext } from '../ai/context';
import { cluster, groupDetails, groupOffsets, SECRETS, secretsIn } from './fixtures/aiFixtures';

suite('Kafka AI panel protocol', () => {
	test('accepts only well-formed webview messages', () => {
		assert.deepStrictEqual(parsePanelMessage({ command: 'ask', text: ' why? ' }), { command: 'ask', text: ' why? ' });
		assert.strictEqual(parsePanelMessage({ command: 'ask', text: '   ' }), undefined);
		assert.strictEqual(parsePanelMessage({ command: 'ask', text: 42 }), undefined);
		assert.deepStrictEqual(parsePanelMessage({ command: 'chip', task: 'diagnose' }), { command: 'chip', task: 'diagnose' });
		assert.strictEqual(parsePanelMessage({ command: 'chip', task: 'infer-schema' }), undefined, 'only listed chips');
		assert.deepStrictEqual(parsePanelMessage({ command: 'action', id: 'abc' }), { command: 'action', id: 'abc' });
		assert.strictEqual(parsePanelMessage({ command: 'runCommand', command2: 'workbench.action.terminal.new' }), undefined);
		assert.strictEqual(parsePanelMessage(null), undefined);
		assert.strictEqual(parsePanelMessage({ command: 'ask', text: 'x'.repeat(10_000) })!.command, 'ask');
		assert.strictEqual((parsePanelMessage({ command: 'ask', text: 'x'.repeat(10_000) }) as { text: string }).text.length, 4000);
	});

	test('chips cover health, lag, topic and connection errors', () => {
		assert.deepStrictEqual(CHIPS.map((c) => c.task), ['diagnose', 'lag', 'topic', 'explain-error']);
	});

	test('data tables come from the redacted sections, highest priority first', () => {
		const options = redactionFor([cluster], [SECRETS.saslPassword], false);
		const sections = groupContext({ ...groupDetails, members: [{ ...groupDetails.members[0], clientId: `app-${SECRETS.saslUser}` }] }, groupOffsets).map((s) => redactSection(s, options));
		const blocks = toBlocks(sections);
		assert.strictEqual(blocks[0].title, 'Lag per partition (most first)');
		assert.deepStrictEqual(blocks[0].columns, ['Partition', 'Committed', 'End', 'Lag', 'Consumer']);
		assert.deepStrictEqual(secretsIn(JSON.stringify(blocks)), [], 'no secrets in posted context');
	});

	test('Chat view queries for slash commands; extra context needs the panel', () => {
		assert.strictEqual(chatViewQuery({ task: 'lag', prompt: '', label: '', target: { group: 'g1' } }, 'prod'), '/lag prod g1');
		assert.strictEqual(chatViewQuery({ task: 'ask', prompt: 'hi', label: '' }, 'prod'), 'prod hi');
		assert.strictEqual(chatViewQuery({ task: 'explain-message', prompt: '', label: '' }), undefined);
		assert.strictEqual(chatViewQuery({ task: 'diagnose', prompt: '', label: '', extraSections: [{ title: 'x', text: 'y', priority: 1 }] }), undefined);
	});
});

suite('Markdown rendering for webviews', () => {
	test('renders the common Markdown a model writes', () => {
		const html = renderMarkdown('## Verdict\n**Lag** is in `orders/3`.\n\n- one\n- two\n\n1. a\n2. b\n\n```json\n{"a":1}\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> note');
		assert.match(html, /<h4>Verdict<\/h4>/);
		assert.match(html, /<strong>Lag<\/strong> is in <code>orders\/3<\/code>/);
		assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
		assert.match(html, /<ol><li>a<\/li><li>b<\/li><\/ol>/);
		assert.match(html, /<pre data-lang="json"><code>\{&quot;a&quot;:1\}<\/code><\/pre>/);
		assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
		assert.match(html, /<blockquote>note<\/blockquote>/);
	});

	test('escapes HTML and keeps only http(s) links', () => {
		const html = renderMarkdown('<img src=x onerror=alert(1)> [docs](https://kafka.apache.org) [run](command:workbench.action.terminal.new) [js](javascript:alert(1)) `<b>`');
		assert.doesNotMatch(html, /<img|<b>/);
		assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
		assert.match(html, /<a href="https:\/\/kafka\.apache\.org">docs<\/a>/);
		assert.doesNotMatch(html, /href="command:|href="javascript:/);
		assert.match(html, /<code>&lt;b&gt;<\/code>/);
	});

	test('does not italicise snake_case and copes with an unfinished code block while streaming', () => {
		assert.doesNotMatch(renderMarkdown('min_insync_replicas and max_poll'), /<em>/);
		assert.match(renderMarkdown('```\npartial'), /<pre><code>partial<\/code><\/pre>/);
	});
});

suite('AI keys and sign-in', () => {
	test('keys are never shown in full', () => {
		assert.strictEqual(maskKey('sk-ant-api03-abcdefghijklmnop1234'), 'sk-ant-…1234');
		assert.strictEqual(maskKey('AIzaSyD-abcdefghijklmnop9876'), 'AIza…9876');
		assert.strictEqual(maskKey('0123456789abcdef'), '012…cdef');
		assert.strictEqual(maskKey('short'), '••••');
	});

	test('PKCE: the challenge is the base64url SHA-256 of the verifier', () => {
		const { verifier, challenge } = createPkce();
		assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
		const expected = crypto.createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		assert.strictEqual(challenge, expected);
	});

	test('OpenRouter auth URL with a loopback callback, or headless', () => {
		const url = new URL(openRouterAuthUrl('http://localhost:5123/callback', 'CH', 'ST'));
		assert.strictEqual(url.origin + url.pathname, 'https://openrouter.ai/auth');
		assert.strictEqual(url.searchParams.get('callback_url'), 'http://localhost:5123/callback');
		assert.strictEqual(url.searchParams.get('code_challenge'), 'CH');
		assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
		assert.strictEqual(url.searchParams.get('state'), 'ST');
		assert.strictEqual(new URL(openRouterAuthUrl(undefined, 'CH')).searchParams.has('callback_url'), false);
	});
});
