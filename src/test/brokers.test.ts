import * as assert from 'assert';
import { parseBrokers, validateBrokers } from '../kafka/brokers';

suite('validateBrokers', () => {
	test('accepts host:port lists, IPs and bracketed IPv6', () => {
		assert.strictEqual(validateBrokers('localhost:9092'), undefined);
		assert.strictEqual(validateBrokers('kafka-1:9092, kafka-2:9093'), undefined);
		assert.strictEqual(validateBrokers('10.0.0.5:9092,[::1]:9092'), undefined);
	});

	test('explains a missing port', () => {
		assert.strictEqual(validateBrokers('kafka-1:9092, kafka-2'), '“kafka-2” is missing a port — use host:port, comma-separated');
	});

	test('rejects empty input, bad ports and duplicates', () => {
		assert.strictEqual(validateBrokers(' , '), 'Enter at least one broker as host:port');
		assert.strictEqual(validateBrokers('kafka:0'), '“kafka:0” has an invalid port — use 1–65535');
		assert.strictEqual(validateBrokers('kafka:99999'), '“kafka:99999” has an invalid port — use 1–65535');
		assert.strictEqual(validateBrokers('kafka:abc'), '“kafka:abc” isn’t a valid host:port address');
		assert.strictEqual(validateBrokers('a:1,a:1'), 'The same broker is listed twice');
	});

	test('parses and trims the list', () => {
		assert.deepStrictEqual(parseBrokers(' a:1 ,, b:2 '), ['a:1', 'b:2']);
	});
});
