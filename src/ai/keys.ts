import * as crypto from "crypto";
import * as http from "http";
import * as vscode from "vscode";
import { getProvider, ProviderInfo, PROVIDERS } from "./providers/catalog";
import { postJson } from "./providers/http";

const SECRET_PREFIX = "kafka-manager.ai.apiKey.";

export interface ResolvedKey {
  key: string;
  /** "stored": secret storage (typed in or from a sign-in). "env": an environment variable. */
  source: "stored" | "env";
  envVar?: string;
}

let secrets: vscode.SecretStorage | undefined;
const changed = new vscode.EventEmitter<string>();
/** Fires with the provider id whenever its stored key is set or removed. */
export const onDidChangeAiKey = changed.event;

/** Called once from `activate`. */
export function initAiKeys(storage: vscode.SecretStorage): vscode.Disposable {
  secrets = storage;
  return storage.onDidChange((e) => {
    if (e.key.startsWith(SECRET_PREFIX)) {
      changed.fire(e.key.slice(SECRET_PREFIX.length));
    }
  });
}

export async function getStoredKey(providerId: string): Promise<string | undefined> {
  return (await secrets?.get(SECRET_PREFIX + providerId))?.trim() || undefined;
}

/** The key for `provider`: stored first, then its environment variables. */
export async function resolveKey(provider: ProviderInfo, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedKey | undefined> {
  const stored = await getStoredKey(provider.id);
  if (stored) {
    return { key: stored, source: "stored" };
  }
  for (const name of provider.envVars) {
    const value = env[name]?.trim();
    if (value) {
      return { key: value, source: "env", envVar: name };
    }
  }
  return undefined;
}

export async function storeKey(providerId: string, key: string): Promise<void> {
  if (!secrets) {
    throw new Error("Secret storage isn't ready.");
  }
  await secrets.store(SECRET_PREFIX + providerId, key.trim());
}

export async function deleteKey(providerId: string): Promise<void> {
  await secrets?.delete(SECRET_PREFIX + providerId);
}

/** Every stored AI key, for redaction: a key must never end up in a prompt. */
export async function allStoredKeys(): Promise<string[]> {
  const values = await Promise.all(PROVIDERS.map((p) => getStoredKey(p.id)));
  const env = PROVIDERS.flatMap((p) => p.envVars.map((v) => process.env[v]?.trim()));
  return [...values, ...env].filter((v): v is string => !!v && v.length >= 8);
}

/** Shows a key as `sk-ant-…a1b2`, never in full. */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 8) {
    return "••••";
  }
  const prefix = k.match(/^(?:sk-(?:ant-|or-|proj-)?|gsk_|xai-|AIza)/)?.[0] ?? k.slice(0, 3);
  return `${prefix}…${k.slice(-4)}`;
}

// ---- OpenRouter sign-in (OAuth PKCE) ----------------------------------------

const OPENROUTER_AUTH = "https://openrouter.ai/auth";
const OPENROUTER_KEYS = "https://openrouter.ai/api/v1/auth/keys";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkce(): PkcePair {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function openRouterAuthUrl(callbackUrl: string | undefined, challenge: string, state?: string): string {
  const params = new URLSearchParams();
  if (callbackUrl) {
    params.set("callback_url", callbackUrl);
  }
  params.set("code_challenge", challenge);
  params.set("code_challenge_method", "S256");
  params.set("key_label", "Kafka Manager (VS Code)");
  if (state) {
    params.set("state", state);
  }
  return `${OPENROUTER_AUTH}?${params.toString()}`;
}

const DONE_PAGE = (ok: boolean, text: string) => `<!doctype html><meta charset="utf-8"><title>Kafka Manager</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5">
<h2>${ok ? "Signed in to OpenRouter" : "Sign-in failed"}</h2><p>${text}</p></body>`;

/** Waits for OpenRouter to redirect the browser back with `?code=`. */
function waitForCallback(state: string, token: vscode.CancellationToken): Promise<{ server: http.Server; port: number; code: Promise<string> }> {
  return new Promise((resolveServer, rejectServer) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const code = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const received = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state || !received) {
        res.writeHead(400, { "content-type": "text/html" }).end(DONE_PAGE(false, "The response didn't match this sign-in. Start again from VS Code."));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(DONE_PAGE(true, "You can close this tab and go back to VS Code."));
      resolveCode(received);
    });
    const timer = setTimeout(() => rejectCode(new Error("Sign-in timed out.")), SIGN_IN_TIMEOUT_MS);
    const cancel = token.onCancellationRequested(() => rejectCode(new Error("Sign-in cancelled.")));
    code.finally(() => {
      clearTimeout(timer);
      cancel.dispose();
      server.close();
    }).catch(() => undefined);
    server.on("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({ server, port: typeof address === "object" && address ? address.port : 0, code });
    });
  });
}

async function exchangeCode(code: string, verifier: string, token: vscode.CancellationToken): Promise<string> {
  const json = await postJson<{ key?: string }>(
    OPENROUTER_KEYS,
    {},
    { code, code_verifier: verifier, code_challenge_method: "S256" },
    "OpenRouter",
    token,
  );
  if (!json.key) {
    throw new Error("OpenRouter didn't return a key.");
  }
  return json.key;
}

/**
 * Signs in to OpenRouter in the browser and stores the key it creates.
 * Uses a loopback callback; if the browser can't reach it (some remote
 * setups), falls back to pasting the code OpenRouter shows.
 */
export async function signInToOpenRouter(): Promise<boolean> {
  const { verifier, challenge } = createPkce();
  const state = base64Url(crypto.randomBytes(16));
  return (
    (await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Signing in to OpenRouter in your browser…", cancellable: true },
      async (_progress, token) => {
        let pending: Awaited<ReturnType<typeof waitForCallback>> | undefined;
        try {
          pending = await waitForCallback(state, token);
        } catch {
          pending = undefined;
        }
        if (!pending) {
          return pasteCodeSignIn(verifier, challenge, token);
        }
        const local = vscode.Uri.parse(`http://localhost:${pending.port}/callback`);
        const external = await vscode.env.asExternalUri(local);
        const opened = await vscode.env.openExternal(vscode.Uri.parse(openRouterAuthUrl(external.toString(true), challenge, state), true));
        if (!opened) {
          pending.server.close();
          return false;
        }
        let code: string;
        try {
          code = await pending.code;
        } catch (error) {
          if (!token.isCancellationRequested) {
            vscode.window.showWarningMessage(`OpenRouter sign-in: ${error instanceof Error ? error.message : String(error)}`);
          }
          return false;
        }
        const key = await exchangeCode(code, verifier, token);
        await storeKey("openrouter", key);
        return true;
      },
    )) === true
  );
}

/** Headless sign-in: OpenRouter shows a code, the user pastes it here. */
async function pasteCodeSignIn(verifier: string, challenge: string, token: vscode.CancellationToken): Promise<boolean> {
  await vscode.env.openExternal(vscode.Uri.parse(openRouterAuthUrl(undefined, challenge), true));
  const code = await vscode.window.showInputBox({
    title: "Sign in to OpenRouter",
    prompt: "Approve Kafka Manager in the browser, then paste the code OpenRouter shows",
    ignoreFocusOut: true,
  });
  if (!code?.trim()) {
    return false;
  }
  await storeKey("openrouter", await exchangeCode(code.trim(), verifier, token));
  return true;
}

/** Label of a provider id, for messages. */
export function providerLabel(id: string): string {
  return getProvider(id)?.label ?? id;
}
