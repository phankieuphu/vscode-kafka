import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	KafkaJSConnectionError,
	KafkaJSNumberOfRetriesExceeded,
	KafkaJSSASLAuthenticationError,
} from 'kafkajs';
import { describeError } from '../kafka/clusterManager';
import {
	awsRegionFromBrokers,
	buildKafkaConfig,
	connectionKey,
	securityLabel,
	suggestSecurity,
} from '../kafka/connectionConfig';
import { explainConnectionError } from '../kafka/connectionHints';
import { ClusterConfig } from '../kafka/types';

// The typings declare a no-arg constructor, but at runtime it takes a message.
const SASLAuthenticationError = KafkaJSSASLAuthenticationError as unknown as new (message: string) => Error;

const base: ClusterConfig = { id: 'c1', name: 'Test', brokers: ['localhost:9092'] };

function connError(message: string, broker?: string, code?: string): KafkaJSConnectionError {
	return new KafkaJSConnectionError(message, { broker, code } as never);
}

suite('buildKafkaConfig', () => {
	test('plaintext clusters get no ssl or sasl', () => {
		const config = buildKafkaConfig(base);
		assert.deepStrictEqual(config.brokers, ['localhost:9092']);
		assert.strictEqual(config.ssl, undefined);
		assert.strictEqual(config.sasl, undefined);
	});

	test('SCRAM uses the supplied password and requires one', () => {
		const cluster: ClusterConfig = { ...base, ssl: true, sasl: { mechanism: 'scram-sha-512', username: 'alice' } };
		const config = buildKafkaConfig(cluster, 's3cret');
		assert.strictEqual(config.ssl, true);
		assert.deepStrictEqual(config.sasl, { mechanism: 'scram-sha-512', username: 'alice', password: 's3cret' });
		assert.throws(() => buildKafkaConfig(cluster), /No password saved for "alice"/);
	});

	test('AWS IAM forces TLS and uses an OAUTHBEARER token provider', () => {
		const config = buildKafkaConfig({ ...base, sasl: { mechanism: 'aws-iam', region: 'us-east-1' } });
		assert.strictEqual(config.ssl, true);
		assert.strictEqual(config.sasl?.mechanism, 'oauthbearer');
		assert.strictEqual(typeof (config.sasl as { oauthBearerProvider: unknown }).oauthBearerProvider, 'function');
	});

	test('custom CA files are read, and unverified TLS is passed through', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kafka-ca-'));
		const caFile = path.join(dir, 'ca.pem');
		fs.writeFileSync(caFile, 'PEM');
		try {
			assert.deepStrictEqual(buildKafkaConfig({ ...base, ssl: { caFile } }).ssl, { rejectUnauthorized: true, ca: ['PEM'] });
			assert.deepStrictEqual(buildKafkaConfig({ ...base, ssl: { rejectUnauthorized: false } }).ssl, { rejectUnauthorized: false });
			assert.throws(() => buildKafkaConfig({ ...base, ssl: { caFile: path.join(dir, 'missing.pem') } }), /Can't read the CA file/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('connectionKey ignores the name but not security', () => {
		assert.strictEqual(connectionKey(base), connectionKey({ ...base, name: 'Renamed' }));
		assert.notStrictEqual(connectionKey(base), connectionKey({ ...base, ssl: true }));
	});

	test('securityLabel summarises the settings', () => {
		assert.strictEqual(securityLabel(base), 'Plaintext');
		assert.strictEqual(securityLabel({ ssl: true, sasl: { mechanism: 'plain', username: 'k' } }), 'SASL/PLAIN · TLS');
		assert.strictEqual(securityLabel({ sasl: { mechanism: 'aws-iam', region: 'eu-west-1' } }), 'AWS IAM · TLS');
		assert.strictEqual(securityLabel({ ssl: { rejectUnauthorized: false } }), 'TLS (unverified)');
	});
});

suite('suggestSecurity / awsRegionFromBrokers', () => {
	const msk = 'b-1.demo.abc123.c2.kafka.us-east-1.amazonaws.com';

	test('recognises MSK listener ports', () => {
		assert.strictEqual(suggestSecurity([`${msk}:9098`]).kind, 'aws-iam');
		assert.strictEqual(suggestSecurity([`${msk}:9096`]).kind, 'scram-sha-512');
		assert.strictEqual(suggestSecurity([`${msk}:9094`]).kind, 'tls');
		assert.strictEqual(suggestSecurity([`${msk}:9092`]).kind, 'none');
	});

	test('recognises hosted services and defaults to none', () => {
		assert.strictEqual(suggestSecurity(['pkc-123.us-west-2.aws.confluent.cloud:9092']).kind, 'plain');
		assert.strictEqual(suggestSecurity(['localhost:9092']).kind, 'none');
	});

	test('extracts the MSK region', () => {
		assert.strictEqual(awsRegionFromBrokers([`${msk}:9098`]), 'us-east-1');
		assert.strictEqual(awsRegionFromBrokers(['boot-x.c1.kafka-serverless.eu-west-1.amazonaws.com:9098']), 'eu-west-1');
		assert.strictEqual(awsRegionFromBrokers(['localhost:9092']), undefined);
	});
});

suite('describeError', () => {
	test('fills in the code when Node leaves the message empty', () => {
		const cause = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
		const error = new KafkaJSConnectionError('Connection error: ', { code: 'ECONNREFUSED' } as never);
		assert.strictEqual(describeError(error), 'Connection error: ECONNREFUSED');
		assert.strictEqual(describeError(new Error('Connection error: ', { cause })), 'Connection error: ECONNREFUSED');
		assert.strictEqual(describeError(new Error('Closed connection')), 'Closed connection');
	});
});

suite('explainConnectionError', () => {
	test('Docker: an advertised broker other than the bootstrap one is unreachable', () => {
		const error = connError('Connection error: getaddrinfo ENOTFOUND kafka', 'kafka:9092', 'ENOTFOUND');
		assert.match(explainConnectionError(base, error) ?? '', /advertises kafka:9092.*advertised\.listeners/);
	});

	test('Docker: nothing listening on localhost', () => {
		const error = connError('Connection error: connect ECONNREFUSED 127.0.0.1:9092', 'localhost:9092', 'ECONNREFUSED');
		assert.match(explainConnectionError(base, error) ?? '', /port is published.*host\.docker\.internal/);
	});

	test('plaintext client against a secured MSK port', () => {
		const cluster = { ...base, brokers: ['b-1.x.kafka.us-east-1.amazonaws.com:9096'] };
		const error = new KafkaJSNumberOfRetriesExceeded(connError('Connection timeout', cluster.brokers[0]), { retryCount: 2, retryTime: 100 });
		assert.match(explainConnectionError(cluster, error) ?? '', /requires SASL\/SCRAM over TLS/);
	});

	test('MSK host that does not resolve outside the VPC', () => {
		const cluster = { ...base, brokers: ['b-1.x.kafka.us-east-1.amazonaws.com:9092'] };
		const error = connError('Connection error: getaddrinfo ENOTFOUND b-1.x.kafka.us-east-1.amazonaws.com', cluster.brokers[0], 'ENOTFOUND');
		assert.match(explainConnectionError(cluster, error) ?? '', /only resolve inside the VPC/);
	});

	test('wrong SASL password', () => {
		const cluster: ClusterConfig = { ...base, ssl: true, sasl: { mechanism: 'scram-sha-512', username: 'alice' } };
		const error = new SASLAuthenticationError('SASL SCRAM SHA512 authentication failed: Authentication failed during authentication due to invalid credentials');
		assert.match(explainConnectionError(cluster, error) ?? '', /username and password/);
	});

	test('SASL mechanism the broker does not enable', () => {
		const cluster: ClusterConfig = { ...base, sasl: { mechanism: 'scram-sha-512', username: 'alice' } };
		const error = new Error('The broker does not support the requested SASL mechanism');
		assert.match(explainConnectionError(cluster, error) ?? '', /doesn't accept SCRAM-SHA-512/);
	});

	test('plaintext client against a SASL listener', () => {
		assert.match(explainConnectionError(base, connError('Closed connection', 'localhost:9092')) ?? '', /closed the connection.*TLS or SASL/);
	});

	test('TLS against a plaintext listener, and untrusted certificates', () => {
		const cluster: ClusterConfig = { ...base, ssl: true };
		assert.match(explainConnectionError(cluster, connError('Connection error: Client network socket disconnected before secure TLS connection was established', 'localhost:9092')) ?? '', /probably plaintext/);
		assert.match(explainConnectionError(cluster, connError('Connection error: self-signed certificate in certificate chain', 'localhost:9092')) ?? '', /certificate isn't trusted/);
	});

	test('missing AWS credentials', () => {
		const cluster: ClusterConfig = { ...base, sasl: { mechanism: 'aws-iam', region: 'us-east-1', profile: 'dev' } };
		assert.match(explainConnectionError(cluster, new Error('Could not load credentials from any providers')) ?? '', /aws sso login/);
	});

	test('nothing to add for unrelated errors', () => {
		assert.strictEqual(explainConnectionError(base, new Error('boom')), undefined);
	});
});
