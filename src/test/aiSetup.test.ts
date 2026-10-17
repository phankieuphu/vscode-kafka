import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveProvider, toHttpModelOptions, toVscodeModelOptions } from '../ai/model';
import { getProvider } from '../ai/providers/catalog';
import { SetupState, setupItems } from '../ai/setup';
import { AiSettings, consentDetail } from '../ai/settings';

const defaults: AiSettings = {
	enabled: true,
	provider: 'auto',
	maxOutputTokens: 2048,
	includeMessagePayloads: false,
	maskHosts: false,
	chatLocation: 'panel',
	autoAnalyzeLagAlerts: false,
};

function actions(state: SetupState): string[] {
	return setupItems(state).filter((i) => i.action).map((i) => i.action!);
}

function row(state: SetupState, action: string) {
	return setupItems(state).find((i) => i.action === action);
}

suite('AI setup picker', () => {
	const anthropic = getProvider('anthropic')!;
	const ready: SetupState = {
		trusted: true,
		settings: { ...defaults, provider: 'anthropic' },
		consented: true,
		provider: anthropic,
		credential: { kind: 'stored', masked: 'sk-ant-…1234' },
		model: { name: 'Claude Sonnet 5.5' },
	};

	test('a working setup offers provider, key, endpoint, model, privacy toggles and a test', () => {
		assert.deepStrictEqual(actions(ready), [
			'toggleEnabled', 'pickProvider', 'credentials', 'removeKey', 'baseUrl', 'pickModel',
			'togglePayloads', 'toggleMaskHosts', 'reviewNotice', 'chat', 'test', 'chatLocation', 'showOutput', 'openSettings',
		]);
		assert.strictEqual(row(ready, 'pickProvider')!.description, 'Anthropic Claude');
		assert.match(row(ready, 'credentials')!.description!, /sk-ant-…1234 · in your OS keychain/);
		assert.strictEqual(row(ready, 'pickModel')!.description, 'Claude Sonnet 5.5 (recommended)');
		assert.strictEqual(row(ready, 'togglePayloads')!.description, 'Not sent');
		assert.strictEqual(row(ready, 'chatLocation')!.description, 'Kafka AI panel');
	});

	test('a missing key says where to get one; OpenRouter offers browser sign-in', () => {
		const noKey: SetupState = { ...ready, credential: { kind: 'missing' }, model: { problem: 'No Anthropic Claude API key.' } };
		assert.match(row(noKey, 'credentials')!.detail!, /console\.anthropic\.com/);
		assert.ok(!actions(noKey).includes('test') && !actions(noKey).includes('removeKey'));
		const openrouter: SetupState = { ...noKey, provider: getProvider('openrouter')!, settings: { ...defaults, provider: 'openrouter' } };
		assert.match(row(openrouter, 'credentials')!.label, /Not signed in/);
		assert.match(row(openrouter, 'credentials')!.detail!, /sign in to OpenRouter/);
	});

	test('keys from the environment, local servers and VS Code models', () => {
		assert.strictEqual(row({ ...ready, credential: { kind: 'env', envVar: 'ANTHROPIC_API_KEY' } }, 'credentials')!.description, 'from $ANTHROPIC_API_KEY');
		const ollama: SetupState = { ...ready, provider: getProvider('ollama')!, credential: { kind: 'notNeeded' } };
		assert.strictEqual(row(ollama, 'credentials')!.description, 'Not needed');
		const copilot: SetupState = { ...ready, provider: getProvider('vscode')!, credential: { kind: 'vscode' } };
		assert.ok(!actions(copilot).includes('baseUrl'));
		assert.strictEqual(row(copilot, 'credentials')!.description, 'Handled by VS Code');
	});

	test('untrusted workspaces explain why and offer no provider, model or test', () => {
		const state: SetupState = { ...ready, trusted: false, model: undefined };
		const list = actions(state);
		assert.strictEqual(list[0], 'trust');
		assert.ok(!list.includes('pickModel') && !list.includes('pickProvider') && !list.includes('test') && !list.includes('chat'));
	});

	test('turned off: can be turned back on, nothing to test', () => {
		const state: SetupState = { ...ready, settings: { ...ready.settings, enabled: false } };
		assert.strictEqual(row(state, 'toggleEnabled')!.description, 'Off');
		assert.ok(!actions(state).includes('test'));
	});

	test('shows a pinned model and opted-in payloads', () => {
		const state: SetupState = {
			...ready,
			settings: { ...ready.settings, model: 'claude-opus-5-5', includeMessagePayloads: true, maskHosts: true, chatLocation: 'chatView' },
			consented: false,
		};
		assert.strictEqual(row(state, 'pickModel')!.description, 'Claude Sonnet 5.5');
		assert.strictEqual(row(state, 'togglePayloads')!.description, 'Sent, truncated');
		assert.strictEqual(row(state, 'toggleMaskHosts')!.description, 'Masked');
		assert.strictEqual(row(state, 'reviewNotice')!.description, 'Not accepted yet');
		assert.match(row(state, 'chatLocation')!.description!, /@kafka/);
	});

	test('the data notice names the destination and what is never sent', () => {
		const cloud = consentDetail(defaults, { id: 'anthropic@api.anthropic.com', label: 'Anthropic Claude', where: 'api.anthropic.com' });
		assert.match(cloud, /Anthropic Claude \(api\.anthropic\.com\)/);
		assert.match(cloud, /Never sent: passwords, SASL usernames, API keys/);
		const local = consentDetail({ ...defaults, includeMessagePayloads: true }, { id: 'ollama@localhost:11434', label: 'Ollama (local)', where: 'this machine (localhost:11434)', local: true });
		assert.match(local, /Nothing leaves this machine/);
		assert.match(local, /Message keys and values: sent/);
	});

	test('every contributed AI command is registered', async () => {
		await vscode.extensions.all.find((e) => e.packageJSON.name === 'kafka-manager')?.activate();
		const registered = new Set(await vscode.commands.getCommands(true));
		const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
		const ai = manifest.contributes.commands.map((c: { command: string }) => c.command).filter((c: string) => /\.ai[A-Z]|Ai($|[A-Z])|analyzeLag|OpenRouter/.test(c));
		assert.ok(ai.length >= 16, `only ${ai.length} AI commands`);
		for (const id of ai) {
			assert.ok(registered.has(id), `${id} is not registered`);
		}
	});

	test('provider and endpoint settings are user-only', () => {
		const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
		const props = manifest.contributes.configuration.properties;
		assert.strictEqual(props['kafka.ai.provider'].scope, 'application');
		assert.strictEqual(props['kafka.ai.baseUrl'].scope, 'application');
		assert.ok(props['kafka.ai.provider'].enum.includes('anthropic') && props['kafka.ai.provider'].enum.includes('gemini'));
	});
});

suite('AI model choices', () => {
	const models = [
		{ id: 'copilot-gpt', family: 'gpt-5', name: 'GPT-5', vendor: 'copilot', maxInputTokens: 64000 },
		{ id: 'copilot-gpt-2', family: 'gpt-5', name: 'GPT-5 (preview)', vendor: 'copilot', maxInputTokens: 64000 },
		{ id: 'copilot-claude', family: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'copilot', maxInputTokens: 80000 },
	];

	test('VS Code models: one option per family, the first being the default', () => {
		const options = toVscodeModelOptions(models);
		assert.deepStrictEqual(options.map((o) => o.name), ['GPT-5', 'Claude Sonnet 5']);
		assert.deepStrictEqual(options.map((o) => o.recommended), [true, false]);
		assert.deepStrictEqual(toVscodeModelOptions(models, 'claude-sonnet-5').map((o) => o.selected), [false, true]);
		assert.deepStrictEqual(toVscodeModelOptions(models, 'copilot-claude').map((o) => o.selected), [false, true]);
	});

	test('HTTP models: chat models only, recommended first, the setting marked', () => {
		const options = toHttpModelOptions(getProvider('anthropic')!, [
			{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', maxInputTokens: 200000 },
			{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
			{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
		], 'claude-haiku-5-5');
		assert.deepStrictEqual(options.map((o) => o.id), ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']);
		assert.ok(options[0].recommended);
		assert.ok(options[2].selected);
		assert.match(options[1].detail!, /200,000 input tokens/);
	});

	test('a provider without its key explains how to add one', async () => {
		const result = await resolveProvider({ ...defaults, provider: 'anthropic' });
		if ('problem' in result) {
			assert.match(result.problem, /Set AI API Key|ANTHROPIC_API_KEY/);
		} else {
			// A developer machine may have ANTHROPIC_API_KEY set.
			assert.strictEqual(result.key?.source, 'env');
		}
		const custom = await resolveProvider({ ...defaults, provider: 'custom' });
		assert.ok('problem' in custom && /endpoint URL/.test(custom.problem));
		const insecure = await resolveProvider({ ...defaults, provider: 'custom', baseUrl: 'http://gw.example.com/v1' });
		assert.ok('problem' in insecure && /https/.test(insecure.problem));
		const unknown = await resolveProvider({ ...defaults, provider: 'nope' });
		assert.ok('problem' in unknown && /Unknown AI provider/.test(unknown.problem));
	});
});
