import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConnectionOptions } from "tls";
import { KafkaConfig, SASLOptions } from "kafkajs";
import { ClusterConfig, ClusterSasl } from "./types";

/** Only the fields that change how we talk to the brokers; a rename must not force a reconnect. */
export function connectionKey(cluster: ClusterConfig): string {
  return JSON.stringify([cluster.brokers, cluster.ssl ?? null, cluster.sasl ?? null]);
}

export function usesTls(cluster: Pick<ClusterConfig, "ssl" | "sasl">): boolean {
  // MSK only offers IAM on its TLS listeners.
  return cluster.sasl?.mechanism === "aws-iam" || (cluster.ssl !== undefined && cluster.ssl !== false);
}

export function needsPassword(sasl: ClusterSasl | undefined): boolean {
  return sasl !== undefined && sasl.mechanism !== "aws-iam";
}

const MECHANISM_LABELS: Record<ClusterSasl["mechanism"], string> = {
  plain: "SASL/PLAIN",
  "scram-sha-256": "SASL/SCRAM-SHA-256",
  "scram-sha-512": "SASL/SCRAM-SHA-512",
  "aws-iam": "AWS IAM",
};

export function mechanismLabel(mechanism: ClusterSasl["mechanism"]): string {
  return MECHANISM_LABELS[mechanism];
}

/** e.g. "SASL/SCRAM-SHA-512 · TLS", "TLS (unverified)", "Plaintext". */
export function securityLabel(cluster: Pick<ClusterConfig, "ssl" | "sasl">): string {
  const parts: string[] = [];
  if (cluster.sasl) {
    parts.push(mechanismLabel(cluster.sasl.mechanism));
  }
  if (usesTls(cluster)) {
    const ssl = typeof cluster.ssl === "object" ? cluster.ssl : {};
    parts.push(
      ssl.rejectUnauthorized === false
        ? "TLS (unverified)"
        : ssl.caFile
          ? "TLS (custom CA)"
          : "TLS",
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "Plaintext";
}

function expandHome(file: string): string {
  return file === "~" || file.startsWith("~/") || file.startsWith("~\\")
    ? path.join(os.homedir(), file.slice(1))
    : file;
}

function buildSsl(cluster: ClusterConfig): ConnectionOptions | boolean | undefined {
  if (!usesTls(cluster)) {
    return undefined;
  }
  const options = typeof cluster.ssl === "object" ? cluster.ssl : {};
  if (!options.caFile && options.rejectUnauthorized !== false) {
    return true;
  }
  const ssl: ConnectionOptions = {
    rejectUnauthorized: options.rejectUnauthorized ?? true,
  };
  if (options.caFile) {
    const file = expandHome(options.caFile);
    try {
      ssl.ca = [fs.readFileSync(file, "utf8")];
    } catch (error) {
      throw new Error(
        `Can't read the CA file "${options.caFile}" for "${cluster.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return ssl;
}

/**
 * An OAUTHBEARER token provider that signs MSK IAM tokens with the AWS
 * credential chain (or a named profile). Tokens are reused until shortly
 * before they expire. The signer (and the AWS SDK behind it) is loaded
 * lazily so plaintext users never pay for it.
 */
function mskIamTokenProvider(region: string, profile?: string) {
  let cached: { value: string; expiresAt: number } | undefined;
  return async () => {
    if (!cached || Date.now() > cached.expiresAt - 60_000) {
      const signer = await import("aws-msk-iam-sasl-signer-js");
      const { token, expiryTime } = profile
        ? await signer.generateAuthTokenFromProfile({ region, awsProfileName: profile })
        : await signer.generateAuthToken({ region });
      cached = { value: token, expiresAt: expiryTime };
    }
    return { value: cached.value };
  };
}

export function buildKafkaConfig(cluster: ClusterConfig, password?: string): KafkaConfig {
  const config: KafkaConfig = {
    clientId: "vscode-kafka",
    brokers: cluster.brokers,
    requestTimeout: 10_000,
  };
  const ssl = buildSsl(cluster);
  if (ssl !== undefined) {
    config.ssl = ssl;
  }
  const sasl = cluster.sasl;
  if (sasl?.mechanism === "aws-iam") {
    config.sasl = {
      mechanism: "oauthbearer",
      oauthBearerProvider: mskIamTokenProvider(sasl.region, sasl.profile),
    };
  } else if (sasl) {
    if (password === undefined) {
      throw new Error(`No password saved for "${sasl.username}" on "${cluster.name}".`);
    }
    config.sasl = { mechanism: sasl.mechanism, username: sasl.username, password } as SASLOptions;
  }
  return config;
}

function parseBroker(broker: string): { host: string; port: number } {
  const i = broker.lastIndexOf(":");
  return {
    host: broker.slice(0, i).replace(/^\[|\]$/g, "").toLowerCase(),
    port: Number(broker.slice(i + 1)),
  };
}

export function brokerHosts(brokers: string[]): Array<{ host: string; port: number }> {
  return brokers.map(parseBroker);
}

const AWS_MSK_HOST = /\.kafka(?:-serverless)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/;

/** Region from an MSK bootstrap host such as b-1.x.y.c2.kafka.us-east-1.amazonaws.com. */
export function awsRegionFromBrokers(brokers: string[]): string | undefined {
  for (const { host } of brokerHosts(brokers)) {
    const match = AWS_MSK_HOST.exec(host);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

export type SuggestedSecurity =
  | "none"
  | "tls"
  | "plain"
  | "scram-sha-256"
  | "scram-sha-512"
  | "aws-iam";

/**
 * Best guess at the security a bootstrap list needs, from well-known ports
 * and managed-service hostnames. Only used to order the Add Cluster choices.
 */
export function suggestSecurity(brokers: string[]): { kind: SuggestedSecurity; reason?: string } {
  const hosts = brokerHosts(brokers);
  const isMsk = hosts.some((h) => AWS_MSK_HOST.test(h.host));
  const ports = new Set(hosts.map((h) => h.port));
  if (ports.has(9098) || ports.has(9198)) {
    return { kind: "aws-iam", reason: "Amazon MSK uses port 9098/9198 for IAM" };
  }
  if (ports.has(9096) || ports.has(9196)) {
    return { kind: "scram-sha-512", reason: "Amazon MSK uses port 9096/9196 for SASL/SCRAM" };
  }
  if (ports.has(9094) || ports.has(9194)) {
    return { kind: "tls", reason: "Amazon MSK uses port 9094/9194 for TLS" };
  }
  if (isMsk && ports.has(9092)) {
    return { kind: "none", reason: "Amazon MSK uses port 9092 for plaintext" };
  }
  if (hosts.some((h) => /\.confluent\.cloud$/.test(h.host))) {
    return { kind: "plain", reason: "Confluent Cloud uses SASL/PLAIN with an API key" };
  }
  if (hosts.some((h) => /\.servicebus\.windows\.net$/.test(h.host))) {
    return { kind: "plain", reason: "Azure Event Hubs uses SASL/PLAIN over TLS" };
  }
  if (hosts.some((h) => /\.(aivencloud\.com|upstash\.io|redpanda\.com|cloud\.redpanda\.com)$/.test(h.host))) {
    return { kind: "scram-sha-256", reason: "Hosted Kafka services usually require SASL over TLS" };
  }
  return { kind: "none" };
}
