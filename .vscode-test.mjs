import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
	{
		label: 'unit',
		files: 'out/test/*.test.js',
		// Settings writes (addCluster, rename…) can take over a second each on CI runners.
		mocha: { timeout: 10000 },
	},
	{
		// Needs a broker: KAFKA_BROKERS=localhost:9092 npx vscode-test --label integration
		label: 'integration',
		files: 'out/test/integration/**/*.test.js',
		mocha: { timeout: 90000 },
	},
]);
