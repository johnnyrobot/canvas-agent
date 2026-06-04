/**
 * Streaming NDJSON parser for Ollama's native `/api/chat` responses, which emit
 * one JSON object per line. Pure (operates on any byte stream) and testable.
 */

/** Parse a ReadableStream of UTF-8 bytes into a stream of JSON objects (one per line). */
export async function* parseNdjson<T = unknown>(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<T> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';

  // ReadableStream is async-iterable on Node 20+; cast keeps this robust across lib typings.
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as T;
    }
  }

  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail) as T;
}
