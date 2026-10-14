import { parseSse, SseEvent } from "./sse";
import { AiErrorKind, AiProviderError, CancellationLike } from "./types";

/** Lets tests replace the network. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  body: AsyncIterable<Uint8Array> | null;
  headers?: { get(name: string): string | null };
}>;

let fetchImpl: FetchLike | undefined;

/** Overrides `fetch` (tests); `undefined` restores the global one. */
export function setFetch(impl: FetchLike | undefined): void {
  fetchImpl = impl;
}

function doFetch(...args: Parameters<FetchLike>): ReturnType<FetchLike> {
  if (fetchImpl) {
    return fetchImpl(...args);
  }
  return fetch(args[0], args[1]) as unknown as ReturnType<FetchLike>;
}

const REQUEST_TIMEOUT_MS = 120_000;

/** Statuses worth retrying: rate limits, overloaded or briefly unavailable servers (529 = Anthropic overloaded). */
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
/** Waits before each retry; the server's Retry-After wins when it is sooner than 20 s. */
let retryDelaysMs = [1_000, 3_000, 7_000];
const MAX_RETRY_AFTER_MS = 20_000;

/** Overrides the retry waits (tests). */
export function setRetryDelays(delays: number[]): void {
  retryDelaysMs = delays;
}

/** How long a Retry-After header asks to wait, in ms, if it is usable. */
export function retryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_RETRY_AFTER_MS ? ms : undefined;
}

function sleep(ms: number, token: CancellationLike): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose();
      resolve();
    }, ms);
    const listener = token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Aborts on cancellation, or if no response starts within `timeoutMs` (a streaming answer may then take as long as it needs). */
function linkCancellation(
  token: CancellationLike,
  timeoutMs: number,
): { signal: AbortSignal; responded(): void; dispose(): void; timedOut(): boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const listener = token.onCancellationRequested(() => controller.abort());
  if (token.isCancellationRequested) {
    controller.abort();
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    responded: () => clearTimeout(timer),
    dispose: () => {
      clearTimeout(timer);
      listener.dispose();
    },
  };
}

/** The provider's own error text from a JSON error body, if it has one. */
export function providerMessage(body: string): string | undefined {
  try {
    const json = JSON.parse(body);
    const error = Array.isArray(json) ? json[0]?.error : json?.error;
    const message = typeof error === "string" ? error : error?.message ?? json?.message ?? json?.detail;
    return typeof message === "string" && message.trim() ? message.trim() : undefined;
  } catch {
    const text = body.trim();
    return text && text.length < 300 && !text.startsWith("<") ? text : undefined;
  }
}

/** Turns an HTTP failure into an error a user can act on. */
const retried = (attempts: number) => (attempts > 1 ? `, even after ${attempts} tries` : "");

export function httpError(status: number, statusText: string, body: string, providerLabel: string, attempts = 1): AiProviderError {
  const detail = providerMessage(body);
  const suffix = detail ? ` (${detail})` : "";
  let kind: AiErrorKind;
  let message: string;
  if (status === 401) {
    kind = "auth";
    message = `${providerLabel} rejected the API key. Set a new one with “Kafka: Set AI API Key…”.${suffix}`;
  } else if (status === 403) {
    kind = "permission";
    message = `${providerLabel} refused the request: the key may lack access to this model, or billing isn't set up.${suffix}`;
  } else if (status === 404) {
    kind = "notFound";
    message = `${providerLabel} doesn't know this model or endpoint. Pick another model with “Kafka: Select AI Model…”.${suffix}`;
  } else if (status === 429) {
    kind = "rateLimit";
    message = `${providerLabel} rate limit or quota reached${retried(attempts)}. Wait a minute, or check your plan's quota (free tiers have per-minute and per-day limits).${suffix}`;
  } else if (status === 400 || status === 422) {
    kind = "badRequest";
    message = `${providerLabel} couldn't handle the request.${suffix}`;
  } else if (status === 503 || status === 529) {
    kind = "server";
    message = `${providerLabel} is overloaded right now (${status})${retried(attempts)}. This is on the provider's side and usually passes within minutes: try again shortly, or pick another model with “Kafka: Select AI Model…”.${suffix}`;
  } else if (status >= 500) {
    kind = "server";
    message = `${providerLabel} had a server error (${status})${retried(attempts)}. Try again shortly.${suffix}`;
  } else {
    kind = "other";
    message = `${providerLabel} answered ${status} ${statusText}.${suffix}`;
  }
  return new AiProviderError(message, kind, status);
}

function networkError(error: unknown, url: string, providerLabel: string, timedOut: boolean): AiProviderError {
  if (timedOut) {
    return new AiProviderError(`${providerLabel} didn't answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`, "network");
  }
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? "";
  const local = /^(localhost|127\.|\[::1\])/.test(host);
  const hint =
    code === "ECONNREFUSED" && local
      ? ` Nothing is listening on ${host}; start ${providerLabel} first.`
      : code === "ENOTFOUND"
        ? " Check the endpoint and your network or proxy."
        : "";
  return new AiProviderError(
    `Couldn't reach ${providerLabel} at ${host}: ${cause?.message ?? (error instanceof Error ? error.message : String(error))}.${hint}`,
    "network",
  );
}

async function send(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  providerLabel: string,
  token: CancellationLike,
): Promise<{ response: Awaited<ReturnType<FetchLike>>; done(): void }> {
  // Retrying is safe: it happens before any of the answer has been read.
  for (let attempt = 1; ; attempt++) {
    try {
      return await sendOnce(method, url, headers, body, providerLabel, token, attempt);
    } catch (error) {
      const retry = error instanceof RetryableError && attempt <= retryDelaysMs.length && !token.isCancellationRequested;
      if (!retry) {
        throw error instanceof RetryableError ? error.final : error;
      }
      await sleep(error.waitMs ?? retryDelaysMs[attempt - 1], token);
      if (token.isCancellationRequested) {
        throw new AiProviderError("Cancelled.", "cancelled");
      }
    }
  }
}

/** A retryable HTTP failure, with the error to report if no retry is left. */
class RetryableError extends Error {
  constructor(
    readonly final: AiProviderError,
    readonly waitMs: number | undefined,
  ) {
    super(final.message);
  }
}

async function sendOnce(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  providerLabel: string,
  token: CancellationLike,
  attempt: number,
): Promise<{ response: Awaited<ReturnType<FetchLike>>; done(): void }> {
  const link = linkCancellation(token, REQUEST_TIMEOUT_MS);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await doFetch(url, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: link.signal,
    });
  } catch (error) {
    link.dispose();
    if (token.isCancellationRequested) {
      throw new AiProviderError("Cancelled.", "cancelled");
    }
    throw networkError(error, url, providerLabel, link.timedOut());
  }
  link.responded();
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    link.dispose();
    const error = httpError(response.status, response.statusText, text, providerLabel, attempt);
    if (RETRYABLE.has(response.status)) {
      throw new RetryableError(error, retryAfterMs(response.headers?.get("retry-after")));
    }
    throw error;
  }
  return { response, done: () => link.dispose() };
}

export async function getJson<T>(
  url: string,
  headers: Record<string, string>,
  providerLabel: string,
  token: CancellationLike,
): Promise<T> {
  const { response, done } = await send("GET", url, headers, undefined, providerLabel, token);
  try {
    return JSON.parse(await response.text()) as T;
  } catch {
    throw new AiProviderError(`${providerLabel} sent a response that isn't JSON. Check the endpoint URL.`, "other");
  } finally {
    done();
  }
}

export async function postJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  providerLabel: string,
  token: CancellationLike,
): Promise<T> {
  const { response, done } = await send("POST", url, headers, body, providerLabel, token);
  try {
    return JSON.parse(await response.text()) as T;
  } catch {
    throw new AiProviderError(`${providerLabel} sent a response that isn't JSON.`, "other");
  } finally {
    done();
  }
}

/** POSTs `body` and yields the Server-Sent Events of the response. */
export async function* postSse(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  providerLabel: string,
  token: CancellationLike,
): AsyncGenerator<SseEvent> {
  const { response, done } = await send("POST", url, { accept: "text/event-stream", ...headers }, body, providerLabel, token);
  try {
    if (!response.body) {
      throw new AiProviderError(`${providerLabel} sent an empty response.`, "other");
    }
    for await (const event of parseSse(response.body)) {
      if (token.isCancellationRequested) {
        return;
      }
      yield event;
    }
  } catch (error) {
    if (token.isCancellationRequested) {
      return;
    }
    if (error instanceof AiProviderError) {
      throw error;
    }
    throw networkError(error, url, providerLabel, false);
  } finally {
    done();
  }
}

/** Parses one SSE data payload, failing with a readable error. */
export function parseEventJson(data: string, providerLabel: string): Record<string, unknown> {
  try {
    return JSON.parse(data);
  } catch {
    throw new AiProviderError(`${providerLabel} sent a malformed stream event.`, "other");
  }
}
