import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { decodeField, isPrintableUtf8, schemaIdOf, toJsonText } from '../kafka/decode';
import { SchemaRegistryClient } from '../kafka/schemaRegistry';

const AVRO_SCHEMA = JSON.stringify({
	type: 'record',
	name: 'Order',
	fields: [{ name: 'id', type: 'string' }, { name: 'amount', type: 'int' }],
});

/** A minimal Schema Registry serving one Avro schema (id 7, subject orders-value). */
function startRegistry(): Promise<{ url: string; requests: string[]; close: () => void }> {
	const requests: string[] = [];
	const server = http.createServer((req, res) => {
		requests.push(`${req.url} ${req.headers.authorization ?? ''}`);
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { 'Content-Type': 'application/vnd.schemaregistry.v1+json' });
			res.end(JSON.stringify(body));
		};
		if (req.url === '/schemas/ids/7') {
			send(200, { schema: AVRO_SCHEMA });
		} else if (req.url === '/schemas/ids/7/versions') {
			send(200, [{ subject: 'orders-value', version: 3 }]);
		} else if (req.url === '/subjects/orders-value/versions/latest') {
			send(200, { subject: 'orders-value', id: 7, version: 3, schema: AVRO_SCHEMA });
		} else if (req.url === '/subjects') {
			send(200, ['payments-value', 'orders-value']);
		} else {
			send(404, { error_code: 40403, message: 'Schema not found' });
		}
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests,
		close: () => server.close(),
	})));
}

suite('decodeField', () => {
	test('auto shows printable text as-is and binary as base64', async () => {
		assert.deepStrictEqual(await decodeField(Buffer.from('héllo'), 'auto'), { text: 'héllo', encoding: 'utf-8' });
		assert.deepStrictEqual(await decodeField(Buffer.from([0xff, 0x00, 0x01]), 'auto'), { text: '/wAB', encoding: 'base64' });
		assert.deepStrictEqual(await decodeField(null, 'auto'), { text: null, encoding: 'null' });
	});

	test('hex, base64 and json formats', async () => {
		assert.strictEqual((await decodeField(Buffer.from('hi'), 'hex')).text, '6869');
		assert.strictEqual((await decodeField(Buffer.from('hi'), 'base64')).text, 'aGk=');
		assert.strictEqual((await decodeField(Buffer.from('{"a":1}'), 'json')).text, '{\n  "a": 1\n}');
		const bad = await decodeField(Buffer.from('{oops'), 'json');
		assert.strictEqual(bad.text, '{oops');
		assert.match(bad.error!, /Not valid JSON/);
	});

	test('wire-format payloads without a registry explain what is missing', async () => {
		const field = await decodeField(Buffer.from([0, 0, 0, 0, 7, 1, 2]), 'auto');
		assert.strictEqual(field.encoding, 'base64');
		assert.deepStrictEqual(field.schema, { id: 7, type: 'UNKNOWN' });
		assert.match(field.error!, /Schema Registry/);
	});

	test('asking for Avro on a plain payload reports it is not wire format', async () => {
		const field = await decodeField(Buffer.from('plain'), 'avro');
		assert.strictEqual(field.text, 'plain');
		assert.match(field.error!, /wire format/);
	});

	test('round-trips Avro through a Schema Registry, with schema id and subject', async () => {
		const registry = await startRegistry();
		try {
			const client = new SchemaRegistryClient(registry.url + '/', 'key', 'secret');
			const { buffer, id } = await client.encode('orders-value', { id: 'o-1', amount: 42 });
			assert.strictEqual(id, 7);
			assert.strictEqual(schemaIdOf(buffer), 7);

			const field = await decodeField(buffer, 'auto', client);
			assert.strictEqual(field.encoding, 'avro');
			assert.deepStrictEqual(JSON.parse(field.text!), { id: 'o-1', amount: 42 });
			assert.deepStrictEqual(field.schema, { id: 7, type: 'AVRO', subject: 'orders-value v3' });

			const wrongType = await decodeField(buffer, 'protobuf', client);
			assert.match(wrongType.error!, /AVRO, not PROTOBUF/);

			assert.deepStrictEqual(await client.listSubjects(), ['orders-value', 'payments-value']);
			const auth = `Basic ${Buffer.from('key:secret').toString('base64')}`;
			assert.ok(registry.requests.some((r) => r === `/schemas/ids/7 ${auth}`), 'metadata requests carry basic auth');
		} finally {
			registry.close();
		}
	});
});

suite('decode helpers', () => {
	test('schemaIdOf reads the Confluent header', () => {
		assert.strictEqual(schemaIdOf(Buffer.from([0, 0, 0, 1, 0, 9])), 256);
		assert.strictEqual(schemaIdOf(Buffer.from([1, 0, 0, 1, 0])), undefined);
		assert.strictEqual(schemaIdOf(Buffer.from([0, 0])), undefined);
	});

	test('isPrintableUtf8 rejects invalid UTF-8 and control bytes', () => {
		assert.ok(isPrintableUtf8(Buffer.from('line 1\nline\t2')));
		assert.ok(!isPrintableUtf8(Buffer.from([0xc3, 0x28])));
		assert.ok(!isPrintableUtf8(Buffer.from([0x41, 0x00])));
	});

	test('toJsonText turns bytes and big numbers into strings', () => {
		const text = toJsonText({ b: Buffer.from('hi'), n: 10n ** 20n });
		assert.deepStrictEqual(JSON.parse(text), { b: 'aGk=', n: '100000000000000000000' });
	});
});
