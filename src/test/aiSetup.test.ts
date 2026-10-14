import * as assert from 'assert';
import * as vscode from 'vscode';
import { toCurrentModel, toModelOptions } from '../ai/model';
import { SetupState, setupItems } from '../ai/setup';
import { AiSettings } from '../ai/settings';

const defaults: AiSettings = { enabled: true, includeMessagePayloads: false, maskHosts: false };

function actions(state: SetupState): string[] {
	return setupItems(state).filter((i) => i.action).map((i) => i.action!);
}

function row(state: SetupState, action: string) {
	return setupItems(state).find((i) => i.action === action);
}

suite('AI setup picker', () => {
	const ready: SetupState = { trusted: true, settings: defaults, consented: true, model: { name: 'GPT-4o' } };

	test('a working setup offers the model, privacy toggles and a test', () => {
		assert.deepStrictEqual(actions(ready), [
			'toggleEnabled', 'pickModel', 'togglePayloads', 'toggleMaskHosts', 'reviewNotice', 'chat', 'test', 'showOutput', 'openSettings',
		]);
		assert.strictEqual(row(ready, 'pickModel')!.description, 'GPT-4o (any available)');
		assert.strictEqual(row(ready, 'togglePayloads')!.description, 'Not sent');
		assert.strictEqual(row(ready, 'toggleMaskHosts')!.description, 'Sent as-is');
	});

	test('untrusted workspaces explain why and offer no model or test', () => {
		const state: SetupState = { ...ready, trusted: false, model: undefined };
		const list = actions(state);
		assert.strictEqual(list[0], 'trust');
		assert.ok(!list.includes('pickModel') && !list.includes('test') && !list.includes('chat'));
	});

	test('turned off: can be turned back on, nothing to test', () => {
		const state: SetupState = { ...ready, settings: { ...defaults, enabled: false } };
		assert.strictEqual(row(state, 'toggleEnabled')!.description, 'Off');
		assert.ok(!actions(state).includes('test'));
	});

	test('no model: shows the install hint instead of a test', () => {
		const state: SetupState = { ...ready, model: { problem: 'No chat model is available. Install or sign in to a chat model provider such as GitHub Copilot.' } };
		assert.match(row(state, 'pickModel')!.detail!, /GitHub Copilot/);
		assert.ok(!actions(state).includes('test'));
	});

	test('shows the chosen family and opted-in payloads', () => {
		const state: SetupState = {
			...ready,
			settings: { ...defaults, modelFamily: 'gpt-4o', includeMessagePayloads: true, maskHosts: true },
			consented: false,
		};
		assert.strictEqual(row(state, 'pickModel')!.description, 'GPT-4o');
		assert.strictEqual(row(state, 'togglePayloads')!.description, 'Sent, truncated');
		assert.strictEqual(row(state, 'toggleMaskHosts')!.description, 'Masked');
		assert.strictEqual(row(state, 'reviewNotice')!.description, 'Not accepted yet');
	});

	test('every contributed AI command is registered', async () => {
		await vscode.extensions.all.find((e) => e.packageJSON.name === 'kafka-manager')?.activate();
		const registered = new Set(await vscode.commands.getCommands(true));
		for (const id of ['kafka-manager.aiSetup', 'kafka-manager.selectAiModel', 'kafka-manager.showAiModel', 'kafka-manager.testAi', 'kafka-manager.showAiOutput', 'kafka-manager.askAi', 'kafka-manager.diagnoseWithAi', 'kafka-manager.explainErrorWithAi', 'kafka-manager.explainLagWithAi', 'kafka-manager.explainTopicWithAi']) {
			assert.ok(registered.has(id), `${id} is not registered`);
		}
	});
});

suite('AI model choices', () => {
	const models = [
		{ family: 'gpt-4o', name: 'GPT-4o', vendor: 'copilot', maxInputTokens: 64000 },
		{ family: 'gpt-4o', name: 'GPT-4o (preview)', vendor: 'copilot', maxInputTokens: 64000 },
		{ family: 'claude-sonnet-4', name: 'Claude Sonnet 4', vendor: 'copilot', maxInputTokens: 80000 },
	];

	test('one option per family, the first being what "any model" uses', () => {
		const options = toModelOptions(models);
		assert.deepStrictEqual(options.map((o) => o.name), ['GPT-4o', 'Claude Sonnet 4']);
		assert.deepStrictEqual(options.map((o) => o.isDefault), [true, false]);
		assert.ok(options.every((o) => !o.selected));
	});

	test('marks the family from kafka.ai.modelFamily, and nothing when it is unavailable', () => {
		assert.deepStrictEqual(toModelOptions(models, 'claude-sonnet-4').map((o) => o.selected), [false, true]);
		assert.ok(toModelOptions(models, 'o3').every((o) => !o.selected));
		assert.deepStrictEqual(toModelOptions([]), []);
	});

	test('the current model says whether the setting or the default picked it', () => {
		const gpt = { id: 'copilot-gpt-4o', ...models[0] };
		assert.deepStrictEqual(toCurrentModel(gpt), {
			id: 'copilot-gpt-4o', name: 'GPT-4o', family: 'gpt-4o', vendor: 'copilot', maxInputTokens: 64000, source: 'default',
		});
		assert.strictEqual(toCurrentModel(gpt, 'gpt-4o').source, 'setting');
		assert.strictEqual(toCurrentModel(gpt, 'o3').source, 'default');
	});
});
