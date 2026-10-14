/**
 * Recorded ClusterManager outputs for AI prompt tests. Secrets are planted
 * on purpose: every test checks none of them reach a prompt.
 */
import type { KafkaReader } from '../../ai/tools';
import { BrokerDetails, ClusterConfig, ClusterOverview, ConnectionStatus, ConsumedMessage, GroupDetails, GroupOffsetEntry, TopicConfigEntry, TopicDetails } from '../../kafka/types';

export const SECRETS = {
	saslPassword: 'hunter2-very-secret',
	saslUser: 'svc-orders-user',
	registryPassword: 'reg-pa55word-xyz',
	registryUser: 'SRKEY123456',
	caFile: '/etc/kafka/certs/ca-bundle.pem',
	keyFile: '/home/dev/.ssh/client.key',
	aiKey: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

export const cluster: ClusterConfig = {
	id: 'c1',
	name: 'prod',
	brokers: ['b-1.kafka.example.com:9096', 'b-2.kafka.example.com:9096'],
	ssl: { caFile: SECRETS.caFile, certFile: '/home/dev/.ssh/client.crt', keyFile: SECRETS.keyFile },
	sasl: { mechanism: 'scram-sha-512', username: SECRETS.saslUser },
	schemaRegistry: { url: 'https://registry.example.com', username: SECRETS.registryUser },
};

export const local: ClusterConfig = { id: 'c2', name: 'local', brokers: ['localhost:9092'] };

export const overview: ClusterOverview = {
	clusterId: 'abc',
	controllerId: 1,
	brokers: [
		{ nodeId: 1, host: 'b-1.kafka.example.com', port: 9096, isController: true, leaderCount: 9, replicaCount: 12 },
		{ nodeId: 2, host: 'b-2.kafka.example.com', port: 9096, isController: false, leaderCount: 3, replicaCount: 12 },
	],
	topics: [
		{ name: 'orders', partitionCount: 6, replicationFactor: 2, underReplicated: 1, offline: 0, messageCount: '120000' },
		{ name: 'payments', partitionCount: 6, replicationFactor: 2, underReplicated: 0, offline: 0, messageCount: '5000' },
	],
	groups: [
		{ groupId: 'orders-consumer', state: 'Stable', memberCount: 2, topics: ['orders'], totalLag: '4500' },
		{ groupId: 'payments-consumer', state: 'Empty', memberCount: 0, topics: ['payments'], totalLag: '0' },
	],
	totals: { brokers: 2, topics: 2, partitions: 12, underReplicated: 1, offline: 0, groups: 2, totalLag: '4500' },
};

export const groupDetails: GroupDetails = {
	groupId: 'orders-consumer',
	state: 'Stable',
	protocol: 'range',
	protocolType: 'consumer',
	members: [
		{ memberId: 'm1', clientId: 'orders-app-1', clientHost: '/10.0.0.5', assignment: [{ topic: 'orders', partitions: [0, 1, 2] }] },
		{ memberId: 'm2', clientId: 'orders-app-2', clientHost: '/10.0.0.6', assignment: [{ topic: 'orders', partitions: [3, 4] }] },
	],
};

export const groupOffsets: GroupOffsetEntry[] = [0, 1, 2, 3, 4, 5].map((p) => ({
	topic: 'orders',
	partition: p,
	offset: String(1000 * p),
	low: '0',
	high: String(1000 * p + (p === 3 ? 4000 : 100)),
	lag: String(p === 3 ? 4000 : 100),
}));

export const topicDetails: TopicDetails = {
	name: 'orders',
	replicationFactor: 2,
	underReplicated: 1,
	offline: 0,
	messageCount: '120000',
	partitions: [0, 1, 2, 3, 4, 5].map((p) => ({
		partitionId: p,
		leader: p < 5 ? 1 : 2,
		replicas: [1, 2],
		isr: p === 0 ? [1] : [1, 2],
		low: '0',
		high: '20000',
		messageCount: '20000',
	})),
};

export const topicConfig: TopicConfigEntry[] = [
	{ name: 'min.insync.replicas', value: '2', isDefault: false, readOnly: false, isSensitive: false, isTopicOverride: true },
	{ name: 'retention.ms', value: '-1', isDefault: false, readOnly: false, isSensitive: false, isTopicOverride: true },
	{ name: 'cleanup.policy', value: 'delete', isDefault: true, readOnly: false, isSensitive: false, isTopicOverride: false },
	{ name: 'sasl.jaas.config', value: `org.apache.kafka.common.security.scram.ScramLoginModule required username="${SECRETS.saslUser}" password="${SECRETS.saslPassword}";`, isDefault: false, readOnly: true, isSensitive: false, isTopicOverride: false },
];

export const brokerDetails: BrokerDetails = {
	nodeId: 1,
	host: 'b-1.kafka.example.com',
	port: 9096,
	isController: true,
	leaderCount: 9,
	replicaCount: 12,
	config: [
		{ name: 'auto.create.topics.enable', value: 'true', isDefault: false, readOnly: false, isSensitive: false, source: 'static' },
		{ name: 'default.replication.factor', value: '1', isDefault: false, readOnly: false, isSensitive: false, source: 'static' },
		{ name: 'ssl.keystore.location', value: '/opt/kafka/ssl/broker.keystore.jks', isDefault: false, readOnly: true, isSensitive: false, source: 'static' },
		{ name: 'ssl.keystore.password', value: null, isDefault: false, readOnly: true, isSensitive: true, source: 'static' },
	],
};

export const message: ConsumedMessage = {
	partition: 3,
	offset: '3000',
	key: 'order-42',
	value: JSON.stringify({ id: 42, total: 9.5, card: { token: 'tok_abc' }, password: SECRETS.saslPassword }),
	timestamp: '1760000000000',
	headers: { traceparent: '00-abc-def-01', authorization: `Bearer ${SECRETS.aiKey}` },
	size: 120,
	valueEncoding: 'utf-8',
};

export const undecodable: ConsumedMessage = {
	...message,
	offset: '3001',
	value: 'AAAAAAEKBm9yZGVy',
	valueEncoding: 'base64',
	decodeError: 'Expected JSON but the value starts with 0x00 (magic byte?)',
};

export class FakeManager implements KafkaReader {
	statuses: Record<string, ConnectionStatus> = { c1: 'connected', c2: 'disconnected' };
	clusters = [cluster, local];
	calls: string[] = [];

	getClusters() { return this.clusters; }
	getStatus(id: string) { return this.statuses[id] ?? 'disconnected'; }
	async getClusterOverview() { this.calls.push('overview'); return overview; }
	async listTopics() { return [{ name: 'orders', partitions: [] }, { name: 'payments', partitions: [] }]; }
	async getTopicDetails() { return topicDetails; }
	async getTopicConfig() { return topicConfig; }
	async listConsumerGroups() { return [{ groupId: 'orders-consumer', protocolType: 'consumer' }, { groupId: 'payments-consumer', protocolType: 'consumer' }]; }
	async getGroupDetails() { return groupDetails; }
	async fetchGroupOffsets() { return groupOffsets; }
	async listBrokers() { return overview.brokers; }
	async getBrokerDetails() { return brokerDetails; }
	async listAcls() { return [{ resourceType: 'TOPIC', resourceName: 'orders', patternType: 'LITERAL', principal: `User:${SECRETS.saslUser}`, host: '*', operation: 'READ', permission: 'ALLOW' }]; }
	async browse() { return { messages: [message, undecodable], scanned: 2, truncated: false }; }
	getLastError(id: string) { return id === 'c2' ? 'Connection error: connect ECONNREFUSED 127.0.0.1:9092' : undefined; }
	getLastHint(id: string) { return id === 'c2' ? 'Nothing is listening on localhost:9092.' : undefined; }
	getLastErrorChain(id: string) {
		return id === 'c2'
			? [
				{ name: 'KafkaJSNumberOfRetriesExceeded', message: 'Connection error: connect ECONNREFUSED 127.0.0.1:9092' },
				{ name: 'KafkaJSConnectionError', message: 'Connection error: connect ECONNREFUSED 127.0.0.1:9092', code: 'ECONNREFUSED', broker: 'localhost:9092' },
			]
			: [];
	}
	async getStoredSecrets(id: string) { return id === 'c1' ? [SECRETS.saslPassword, SECRETS.registryPassword] : []; }
}

/** Asserts no planted secret appears in `text`. */
export function secretsIn(text: string): string[] {
	return Object.entries(SECRETS).filter(([, v]) => text.includes(v)).map(([k]) => k);
}
