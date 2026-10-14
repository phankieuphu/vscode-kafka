import { parseSse, SseEvent } from "./sse";
import { AiErrorKind, AiProviderError, CancellationLike } from "./types";

/** Lets tests replace the network. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  body: AsyncIterable<Uint8Array> | null;
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
export function httpError(status: number, statusText: string, body: string, providerLabel: string): AiProviderError {
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
    message = `${providerLabel} rate limit or quota reached. Wait a moment, or check your plan.${suffix}`;
  } else if (status === 400 || status === 422) {
    kind = "badRequest";
    message = `${providerLabel} couldn't handle the request.${suffix}`;
  } else if (status >= 500) {
    kind = "server";
    message = `${providerLabel} had a server error (${status}). Try again shortly.${suffix}`;
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
    throw httpError(response.status, response.statusText, text, providerLabel);
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
