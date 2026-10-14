import * as assert from 'assert';
import { clusterHosts, clusterSecrets, redact, redactionFor, REDACTED, truncatePayload } from '../ai/redact';
import { ClusterConfig } from '../kafka/types';

const scram: ClusterConfig = {
	id: 'c1',
	name: 'Prod',
	brokers: ['b-1.prod.abc123.c2.kafka.us-east-1.amazonaws.com:9096', '[::1]:9092'],
	ssl: { caFile: '/etc/kafka/ca.pem', certFile: '/home/me/certs/service.cert', keyFile: '~/certs/service.key' },
	sasl: { mechanism: 'scram-sha-512', username: 'svc-orders' },
	schemaRegistry: { url: 'https://sr-user:sr-pass@registry.internal:8081', username: 'SRKEY123' },
};
// What SecretStorage holds for the cluster: SASL and Schema Registry passwords.
const stored = ['Pa$$w0rd!(x)', 'registry-Secret+/='];

function assertNoneLeak(text: string, secrets: string[]): void {
	for (const secret of secrets) {
		assert.ok(!text.includes(secret), `"${secret}" leaked into: ${text}`);
	}
}

suite('redact', () => {
	test('no ClusterConfig or SecretStorage secret survives, in any shape', () => {
		const options = redactionFor([scram], stored, false);
		const secrets = [...clusterSecrets(scram, stored), 'sr-user', 'sr-pass'];
		const contexts = [
			JSON.stringify(scram),
			JSON.stringify(scram, null, 2),
			`Connection failed: SASL SCRAM authentication for ${scram.sasl && 'username' in scram.sasl ? scram.sasl.username : ''} failed (password ${stored[0]})`,
			`Schema Registry ${scram.schemaRegistry!.url} returned 401 for ${stored[1]}`,
			`ENOENT: no such file or directory, open '/etc/kafka/ca.pem'`,
		];
		for (const context of contexts) {
			assertNoneLeak(redact(context, options), secrets);
		}
		assert.doesNotThrow(() => JSON.parse(redact(JSON.stringify(scram), options)), 'redacted JSON stays JSON');
	});

	test('strips credentials that are not in the config', () => {
		const text = [
			'sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="bob" password="hunter2";',
			'"sasl.jaas.config": "org.apache...ScramLoginModule required username=\\"bob\\" password=\\"hunter2\\";"',
			'ssl.keystore.password=changeit, basic.auth.user.info: key:secret',
			'aws_access_key_id = AKIAIOSFODNN7EXAMPLE',
			'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
			'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc',
			'loaded ./secrets/client.p12 and C:\\certs\\broker.jks',
			'-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----',
		].join('\n');
		const out = redact(text);
		assertNoneLeak(out, [
			'hunter2', 'bob', 'changeit', 'key:secret', 'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI',
			'eyJhbGciOiJIUzI1NiJ9', 'client.p12', 'broker.jks', 'MIIEvQIBADANBg',
		]);
		assert.ok(out.includes(REDACTED));
	});

	test('leaves ordinary Kafka text alone', () => {
		const text = 'Topic orders has 12 partitions; record.key is null; consumer group billing lags by 4000 tokens of work; retention.ms=604800000';
		assert.strictEqual(redact(text), text);
	});

	test('short secrets are only removed as whole words', () => {
		assert.strictEqual(redact('ab is the password? orders-ab-topic', { secrets: ['ab'] }), `${REDACTED} is the password? orders-ab-topic`);
	});

	test('masks broker and registry hosts only when asked', () => {
		const text = 'Leader for orders-0 is b-1.prod.abc123.c2.kafka.us-east-1.amazonaws.com:9096; registry at registry.internal';
		assert.strictEqual(redact(text, redactionFor([scram], [], false)), text);
		const masked = redact(text, redactionFor([scram], [], true));
		assert.ok(!masked.includes('amazonaws.com') && !masked.includes('registry.internal'), masked);
		assert.ok(masked.includes('host-1:9096'), masked);
		assert.deepStrictEqual(clusterHosts(scram), ['b-1.prod.abc123.c2.kafka.us-east-1.amazonaws.com', '::1', 'registry.internal']);
	});
});

suite('truncatePayload', () => {
	test('keeps short payloads and says how much was cut from long ones', () => {
		assert.strictEqual(truncatePayload('hello', 10), 'hello');
		assert.strictEqual(truncatePayload('x'.repeat(15), 10), `${'x'.repeat(10)}… [5 more characters]`);
	});
});
