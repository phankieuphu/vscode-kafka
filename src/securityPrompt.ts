import * as vscode from "vscode";
import {
  awsRegionFromBrokers,
  mechanismLabel,
  suggestSecurity,
  SuggestedSecurity,
  usesTls,
} from "./kafka/connectionConfig";
import {
  ClusterConfig,
  ClusterSecurity,
  ClusterSsl,
  PasswordSaslMechanism,
} from "./kafka/types";

type Choice = SuggestedSecurity;

const CHOICES: Array<{ choice: Choice; label: string; detail: string }> = [
  { choice: "none", label: "No authentication", detail: "Local and Docker clusters (PLAINTEXT), or TLS without SASL" },
  { choice: "plain", label: "SASL/PLAIN", detail: "Username and password — Confluent Cloud API keys, Azure Event Hubs" },
  { choice: "scram-sha-256", label: "SASL/SCRAM-SHA-256", detail: "Username and password — Aiven, Redpanda, self-managed" },
  { choice: "scram-sha-512", label: "SASL/SCRAM-SHA-512", detail: "Username and password — Amazon MSK (port 9096)" },
  { choice: "aws-iam", label: "AWS IAM", detail: "Amazon MSK IAM access control (port 9098) using your AWS credentials" },
];

/**
 * Walks the user through TLS/SASL settings for `brokers`. `current` pre-fills
 * an existing cluster's settings. Every step is titled `title`. Resolves
 * undefined if any step is cancelled.
 */
export async function promptForSecurity(
  brokers: string[],
  title: string,
  current?: ClusterConfig,
): Promise<ClusterSecurity | undefined> {

  const suggestion = suggestSecurity(brokers);
  const currentKind: Choice | undefined = current
    ? (current.sasl?.mechanism ?? "none")
    : undefined;
  const preferred = currentKind ?? (suggestion.kind === "tls" ? "none" : suggestion.kind);
  const items = CHOICES.map((c) => ({
    ...c,
    description:
      c.choice === currentKind
        ? "current"
        : !current && c.choice === preferred && suggestion.reason
          ? `suggested — ${suggestion.reason}`
          : undefined,
  })).sort((a, b) => Number(b.choice === preferred) - Number(a.choice === preferred));

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "How does this cluster authenticate clients?",
    ignoreFocusOut: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return undefined;
  }

  if (picked.choice === "aws-iam") {
    return promptForAwsIam(brokers, title, current);
  }

  const security: ClusterSecurity = {};
  const ssl = await promptForTls(picked.choice, suggestion.kind, title, current);
  if (ssl === undefined) {
    return undefined;
  }
  if (ssl !== false) {
    security.ssl = ssl;
  }

  if (picked.choice === "none") {
    return security;
  }
  const mechanism = picked.choice as PasswordSaslMechanism;
  const previousUser =
    current?.sasl && current.sasl.mechanism !== "aws-iam" ? current.sasl.username : undefined;
  const username = await vscode.window.showInputBox({
    title,
    prompt: `${mechanismLabel(mechanism)} username (for Confluent Cloud, the API key)`,
    value: previousUser,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "Enter a username" : undefined),
  });
  if (!username) {
    return undefined;
  }
  // Keeping the old password only makes sense when the account didn't change.
  const canKeep = previousUser !== undefined && previousUser === username.trim();
  const password = await vscode.window.showInputBox({
    title,
    prompt: canKeep
      ? "Password — leave empty to keep the saved one. Stored in VS Code's secret storage, not settings.json."
      : "Password — stored in VS Code's secret storage, not settings.json.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.length === 0 && !canKeep ? "Enter a password" : undefined),
  });
  if (password === undefined) {
    return undefined;
  }
  security.sasl = { mechanism, username: username.trim() };
  if (password.length > 0) {
    security.password = password;
  }
  return security;
}

/** Resolves false for plaintext, the ssl setting for TLS, or undefined if cancelled. */
async function promptForTls(
  kind: Choice,
  suggested: Choice,
  title: string,
  current?: ClusterConfig,
): Promise<boolean | ClusterSsl | undefined> {
  const tlsFirst = current
    ? usesTls(current)
    : suggested === "tls" || (kind !== "none" && suggested !== "none");
  const options = [
    { label: "Plaintext", detail: "No TLS — local, Docker and in-VPC plaintext listeners", tls: false },
    { label: "TLS", detail: "Encrypted connection (SSL / SASL_SSL listeners)", tls: true },
  ];
  if (tlsFirst) {
    options.reverse();
  }
  const transport = await vscode.window.showQuickPick(options, {
    title,
    placeHolder: "Does the listener use TLS?",
    ignoreFocusOut: true,
  });
  if (!transport) {
    return undefined;
  }
  if (!transport.tls) {
    return false;
  }

  const existing = current && typeof current.ssl === "object" ? current.ssl : {};
  const verify = await vscode.window.showQuickPick(
    [
      { label: "Verify with system certificates", detail: "Public CAs — MSK, Confluent Cloud and most hosted services", mode: "system" as const },
      { label: "Verify with a CA file…", detail: existing.caFile ?? "PEM file for a private CA", mode: "ca" as const },
      { label: "Don't verify the certificate", detail: "Self-signed dev clusters only — the connection can be intercepted", mode: "insecure" as const },
    ],
    { title, placeHolder: "How should the broker certificate be checked?", ignoreFocusOut: true },
  );
  if (!verify) {
    return undefined;
  }
  if (verify.mode === "system") {
    return true;
  }
  if (verify.mode === "insecure") {
    return { rejectUnauthorized: false };
  }
  const files = await vscode.window.showOpenDialog({
    title: "CA certificate (PEM)",
    canSelectMany: false,
    filters: { Certificates: ["pem", "crt", "cer"], "All files": ["*"] },
    defaultUri: existing.caFile ? vscode.Uri.file(existing.caFile) : undefined,
  });
  if (!files || files.length === 0) {
    return undefined;
  }
  return { caFile: files[0].fsPath };
}

async function promptForAwsIam(
  brokers: string[],
  title: string,
  current?: ClusterConfig,
): Promise<ClusterSecurity | undefined> {
  const previous = current?.sasl?.mechanism === "aws-iam" ? current.sasl : undefined;
  const region = await vscode.window.showInputBox({
    title,
    prompt: "AWS region of the MSK cluster",
    value: previous?.region ?? awsRegionFromBrokers(brokers) ?? process.env.AWS_REGION ?? "",
    placeHolder: "us-east-1",
    ignoreFocusOut: true,
    validateInput: (v) =>
      /^[a-z]{2}(-[a-z]+)+-\d$/.test(v.trim()) ? undefined : "Enter a region such as us-east-1",
  });
  if (!region) {
    return undefined;
  }
  const profile = await vscode.window.showInputBox({
    title,
    prompt: "AWS profile — leave empty for the default credential chain (env vars, default profile, SSO, instance role)",
    value: previous?.profile ?? "",
    ignoreFocusOut: true,
  });
  if (profile === undefined) {
    return undefined;
  }
  return {
    ssl: true,
    sasl: {
      mechanism: "aws-iam",
      region: region.trim(),
      ...(profile.trim() ? { profile: profile.trim() } : {}),
    },
  };
}
