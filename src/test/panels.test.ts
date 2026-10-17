import * as assert from 'assert';
import * as vm from 'vm';
import { ClusterManager } from '../kafka/clusterManager';
import { ClusterConfig } from '../kafka/types';
import { AclPanel } from '../panels/aclPanel';
import { AiChatPanel } from '../panels/aiChatPanel';
import { BrokerPanel } from '../panels/brokerPanel';
import { DashboardPanel } from '../panels/dashboardPanel';
import { GroupPanel } from '../panels/groupPanel';
import { TopicPanel } from '../panels/topicPanel';

type PanelHost = { panels: Map<string, { panel: { webview: { html: string }; dispose(): void } }> };

/**
 * The webview scripts live in template strings, so a typo there only shows up
 * as a dead panel. Render each panel and compile its script.
 */
suite('Webview panels', () => {
	const cluster: ClusterConfig = { id: 'panel-test', name: 'Panels <&> "test"', brokers: ['localhost:1'] };
	let manager: ClusterManager;

	setup(() => {
		manager = new ClusterManager();
	});

	teardown(() => {
		for (const host of [TopicPanel, GroupPanel, DashboardPanel, BrokerPanel, AclPanel, AiChatPanel] as unknown as PanelHost[]) {
			for (const p of [...host.panels.values()]) {
				p.panel.dispose();
			}
		}
		manager.dispose();
	});

	const cases: Array<[string, () => void, unknown, string]> = [
		['topic', () => TopicPanel.createOrShow(manager, cluster, 'orders'), TopicPanel, `${cluster.id}:orders`],
		['group', () => GroupPanel.createOrShow(manager, cluster, 'billing'), GroupPanel, `${cluster.id}:billing`],
		['dashboard', () => DashboardPanel.createOrShow(manager, cluster), DashboardPanel, cluster.id],
		['broker', () => BrokerPanel.createOrShow(manager, cluster, 1), BrokerPanel, `${cluster.id}:1`],
		['ACL', () => AclPanel.createOrShow(manager, cluster), AclPanel, cluster.id],
	];

	for (const [name, open, host, key] of cases) {
		test(`${name} panel script compiles and escapes the cluster name`, () => {
			open();
			const html = (host as PanelHost).panels.get(key)!.panel.webview.html;
			const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
			assert.strictEqual(scripts.length, 1);
			assert.doesNotThrow(() => new vm.Script(scripts[0]), `${name} panel script has a syntax error`);
			assert.ok(!html.includes('Panels <&>'), 'cluster name is escaped in the markup');
		});
	}

	test('Kafka AI chat panel script compiles and keeps a strict CSP', () => {
		AiChatPanel.show(manager, cluster.id);
		const html = (AiChatPanel as unknown as PanelHost).panels.get(cluster.id)!.panel.webview.html;
		const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
		assert.strictEqual(scripts.length, 1);
		assert.doesNotThrow(() => new vm.Script(scripts[0]), 'AI chat panel script has a syntax error');
		assert.match(html, /default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-/);
		assert.doesNotMatch(html, /<script[^>]+src=/, 'no remote scripts');
	});
});
