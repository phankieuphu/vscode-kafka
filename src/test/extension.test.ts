import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { ClusterManager } from '../kafka/clusterManager';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});

suite('ClusterManager.updateClusterName', () => {
	let manager: ClusterManager;

	async function clearClusters(): Promise<void> {
		for (const cluster of manager.getClusters()) {
			await manager.removeCluster(cluster.id);
		}
	}

	setup(async () => {
		manager = new ClusterManager();
		await clearClusters();
	});

	teardown(async () => {
		await clearClusters();
		manager.dispose();
	});

	test('renames a cluster and persists the change', async () => {
		const cluster = await manager.addCluster('Local', ['localhost:9092']);

		const updated = await manager.updateClusterName(cluster.id, 'Renamed');

		assert.strictEqual(updated?.name, 'Renamed');
		// Re-read from configuration to confirm the rename was actually saved,
		// not just mutated on an in-memory object.
		assert.strictEqual(manager.getCluster(cluster.id)?.name, 'Renamed');
	});

	test('leaves the name unchanged when given an empty string', async () => {
		const cluster = await manager.addCluster('Local', ['localhost:9092']);

		const updated = await manager.updateClusterName(cluster.id, '');

		assert.strictEqual(updated?.name, 'Local');
		assert.strictEqual(manager.getCluster(cluster.id)?.name, 'Local');
	});

	test('returns undefined for an unknown cluster id', async () => {
		const updated = await manager.updateClusterName('does-not-exist', 'New name');

		assert.strictEqual(updated, undefined);
	});
});
