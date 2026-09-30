import { brokerHosts, usesTls } from "./connectionConfig";
import { ClusterConfig } from "./types";

const EDIT_SECURITY = "Use “Edit Connection Security” on the cluster to change it.";

/** Walks `error.cause` (KafkaJS nests the real failure under retries/non-retriable wrappers). */
function errorChain(error: unknown): Array<{ name: string; message: string; code?: string; broker?: string }> {
  const chain = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const e = current as Error & { code?: unknown; broker?: unknown; cause?: unknown };
    chain.push({
      name: e.name,
      message: e.message,
      code: typeof e.code === "string" ? e.code : undefined,
      broker: typeof e.broker === "string" ? e.broker : undefined,
    });
    current = e.cause;
  }
  if (chain.length === 0 && error !== undefined) {
    chain.push({ name: "", message: String(error) });
  }
  return chain;
}

function splitBroker(broker: string): { host: string; port: number } {
  return brokerHosts([broker])[0];
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** Ports the managed services dedicate to TLS/SASL listeners. */
const SECURED_PORTS: Record<number, string> = {
  9093: "TLS (the usual SSL listener port)",
  9094: "TLS (Amazon MSK)",
  9096: "SASL/SCRAM over TLS (Amazon MSK)",
  9098: "AWS IAM over TLS (Amazon MSK)",
  9194: "TLS (Amazon MSK public access)",
  9196: "SASL/SCRAM over TLS (Amazon MSK public access)",
  9198: "AWS IAM over TLS (Amazon MSK public access)",
};

const MANAGED_HOST = /\.(confluent\.cloud|servicebus\.windows\.net|aivencloud\.com|upstash\.io|redpanda\.com)$/;

/**
 * Turns a connection failure into one actionable sentence about the likely
 * cause (auth mismatch, TLS mismatch, Docker listeners, unreachable VPC), or
 * undefined when there's nothing more useful to say than the error itself.
 */
export function explainConnectionError(cluster: ClusterConfig, error: unknown): string | undefined {
  const chain = errorChain(error);
  if (chain.length === 0) {
    return undefined;
  }
  const text = chain.map((e) => `${e.name}: ${e.message} ${e.code ?? ""}`).join("\n");
  const has = (re: RegExp) => re.test(text);
  const tls = usesTls(cluster);
  const sasl = cluster.sasl;
  const bootstrap = brokerHosts(cluster.brokers);
  const failedBroker = chain.find((e) => e.broker)?.broker;
  const failed = failedBroker ? splitBroker(failedBroker) : undefined;
  const failedIsBootstrap =
    !failed || bootstrap.some((b) => b.host === failed.host && b.port === failed.port);

  if (sasl?.mechanism === "aws-iam") {
    if (has(/Could not load credentials|CredentialsProviderError|profile .*(not found|could not be found)|Token is expired|SSO session|ExpiredToken/i)) {
      return `Couldn't get AWS credentials${sasl.profile ? ` for profile “${sasl.profile}”` : ""}. Run \`aws sso login\` (or check the profile/environment) and reconnect.`;
    }
    if (has(/KafkaJSSASLAuthenticationError|SASL .*authentication failed|Access denied/i)) {
      return "The broker rejected the IAM identity. Check the region and that the IAM policy allows kafka-cluster:Connect (plus DescribeTopic/ReadData for browsing).";
    }
  }

  if (sasl && sasl.mechanism !== "aws-iam" && has(/KafkaJSSASLAuthenticationError|SASL .*authentication failed|Authentication failed|does not support the requested SASL mechanism|UNSUPPORTED_SASL_MECHANISM/i)) {
    return has(/does not support the requested SASL mechanism|UNSUPPORTED_SASL_MECHANISM/i)
      ? `The broker doesn't accept ${sasl.mechanism.toUpperCase()}. Amazon MSK uses SCRAM-SHA-512, Confluent Cloud uses PLAIN. ${EDIT_SECURITY}`
      : `Check the username and password (and that the mechanism matches the broker). ${EDIT_SECURITY}`;
  }

  if (tls && has(/self[- ]signed|unable to (get|verify)|certificate|CERT_|ERR_TLS/i)) {
    return `The broker's TLS certificate isn't trusted. Add its CA file, or turn off certificate verification for local/test clusters. ${EDIT_SECURITY}`;
  }

  if (tls && has(/wrong version number|before secure TLS connection|EPROTO|packet length too long/i)) {
    return `The broker didn't answer the TLS handshake — this port is probably plaintext. Turn TLS off or use the broker's TLS listener. ${EDIT_SECURITY}`;
  }

  // A broker other than the one we bootstrapped from: the cluster handed us an address we can't use.
  if (!failedIsBootstrap && failed && has(/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|Connection timeout/i)) {
    return advertisedListenerHint([failedBroker!]);
  }

  const target = failed ?? bootstrap[0];
  if (!tls && !sasl && target) {
    const secured = SECURED_PORTS[target.port];
    const managed = MANAGED_HOST.test(target.host);
    if ((secured || managed) && has(/Connection (closed|timeout|error)|Closed connection|ECONNRESET|Request timed out|KafkaJSConnection/i)) {
      return `This broker likely requires ${secured ?? "TLS and SASL"}, but the cluster is set to plaintext. ${EDIT_SECURITY}`;
    }
  }

  if (has(/ENOTFOUND|EAI_AGAIN/)) {
    return /\.amazonaws\.com$/.test(target?.host ?? "")
      ? `Can't resolve ${target!.host}. MSK broker names only resolve inside the VPC — connect over VPN, or use the public-access endpoints.`
      : `Can't resolve ${target?.host ?? "the broker host"}. Check the address${target && !target.host.includes(".") ? " (a container name only resolves inside its Docker network)" : ""}.`;
  }

  if (has(/ECONNREFUSED/) && target && LOCAL_HOSTS.has(target.host)) {
    return `Nothing is listening on ${target.host}:${target.port}. If Kafka runs in Docker, check the container is up and the port is published (e.g. -p ${target.port}:${target.port}). From inside a dev container, use host.docker.internal instead of localhost.`;
  }

  if (/\.amazonaws\.com$/.test(target?.host ?? "") && has(/Connection timeout|ETIMEDOUT|Request timed out/i)) {
    return "MSK brokers are private to their VPC by default. Connect from inside the VPC (VPN, SSH tunnel) or enable public access, and check the security group allows your IP.";
  }

  if (!tls && !sasl && has(/Connection closed|Closed connection|ECONNRESET/i)) {
    return "The broker closed the connection. If it requires TLS or SASL, set that up with “Edit Connection Security” on the cluster.";
  }

  return undefined;
}

function advertisedListenerHint(brokers: string[]): string {
  const list = brokers.join(", ");
  return (
    `The cluster advertises ${list}, which VS Code can't reach. Kafka's advertised.listeners must be an address this machine can reach` +
    ` — for Docker, e.g. KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://localhost:9092 (with a separate internal listener for other containers).`
  );
}
