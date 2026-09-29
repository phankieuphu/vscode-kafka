import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface MenuEntry {
	command: string;
	when?: string;
	group?: string;
}

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
const itemMenus: MenuEntry[] = manifest.contributes.menus['view/item/context'];

/** Evaluates the subset of when-clause syntax used by the tree menus: `a == b` and `a =~ /re/` joined by `&&`. */
function matches(when: string, context: Record<string, string>): boolean {
	return when.split('&&').every((clause) => {
		const eq = clause.match(/^\s*(\w+)\s*==\s*(\S+)\s*$/);
		if (eq) {
			return context[eq[1]] === eq[2];
		}
		const re = clause.match(/^\s*(\w+)\s*=~\s*\/(.*)\/\s*$/);
		if (re) {
			return new RegExp(re[2]).test(context[re[1]] ?? '');
		}
		throw new Error(`Unsupported when clause: ${clause}`);
	});
}

function connectionCommands(status: string, groupPrefix: string): string[] {
	const context = { view: 'kafkaExplorer', viewItem: `kafkaCluster-${status}` };
	return itemMenus
		.filter((m) => /Cluster$/.test(m.command) && /connect/i.test(m.command))
		.filter((m) => m.group?.startsWith(groupPrefix) && matches(m.when ?? 'true', context))
		.map((m) => m.command)
		.sort();
}

suite('Cluster connection menus', () => {
	const expected: Record<string, string[]> = {
		disconnected: ['kafka-manager.connectCluster'],
		connecting: ['kafka-manager.disconnectCluster'],
		connected: ['kafka-manager.disconnectCluster'],
		error: ['kafka-manager.disconnectCluster', 'kafka-manager.reconnectCluster'],
	};

	for (const [status, commands] of Object.entries(expected)) {
		test(`${status} clusters show exactly ${commands.join(' + ')}`, () => {
			assert.deepStrictEqual(connectionCommands(status, 'inline'), commands);
			assert.deepStrictEqual(connectionCommands(status, '0_connection'), commands);
		});
	}

	test('reconnect is declared and hidden from the command palette', () => {
		const declared = manifest.contributes.commands.map((c: { command: string }) => c.command);
		assert.ok(declared.includes('kafka-manager.reconnectCluster'));
		const palette: MenuEntry[] = manifest.contributes.menus.commandPalette;
		assert.ok(palette.some((m) => m.command === 'kafka-manager.reconnectCluster' && m.when === 'false'));
	});
});
