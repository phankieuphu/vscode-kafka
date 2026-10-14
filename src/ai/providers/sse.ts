/** One Server-Sent Event: the `event:` name (if any) and its joined `data:` lines. */
export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Splits a byte or text stream into Server-Sent Events. Handles `\n`, `\r\n`
 * and `\r` line ends, multi-line `data:`, comments and chunks that end
 * mid-line or mid-character.
 */
export async function* parseSse(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  const flushLine = function* (line: string): Generator<SseEvent> {
    if (line === "") {
      if (data.length > 0) {
        yield { event, data: data.join("\n") };
      }
      event = undefined;
      data = [];
      return;
    }
    if (line.startsWith(":")) {
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "data") {
      data.push(value);
    } else if (field === "event") {
      event = value;
    }
  };

  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let match: RegExpExecArray | null;
    // A lone \r at the very end may be the first half of \r\n; wait for more.
    const lineEnd = /\r\n|\n|\r(?!$)/g;
    let start = 0;
    while ((match = lineEnd.exec(buffer))) {
      yield* flushLine(buffer.slice(start, match.index));
      start = match.index + match[0].length;
    }
    buffer = buffer.slice(start);
  }
  buffer += decoder.decode();
  for (const line of buffer.split(/\r\n|\n|\r/)) {
    yield* flushLine(line);
  }
  yield* flushLine("");
}
