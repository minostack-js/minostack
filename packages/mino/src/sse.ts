/**
 * SSE helpers — minimal, Fetch-native.
 */

export type SSEEvent = {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
};

export function formatSSE(event: SSEEvent): string {
  let out = "";
  if (event.id) out += `id: ${event.id}\n`;
  if (event.event) out += `event: ${event.event}\n`;
  if (event.retry != null) out += `retry: ${event.retry}\n`;
  // Split data by newline per SSE spec
  for (const line of event.data.split("\n")) {
    out += `data: ${line}\n`;
  }
  out += "\n";
  return out;
}

/**
 * Create a ReadableStream that yields SSE-formatted strings.
 * Helper for use with `c.sse(stream)`.
 */
export function createSSEStream(
  source: AsyncIterable<SSEEvent> | (() => AsyncGenerator<SSEEvent>),
): ReadableStream<string> {
  const iterable = typeof source === "function" ? source() : source;
  return new ReadableStream<string>({
    async start(controller) {
      try {
        for await (const evt of iterable as AsyncIterable<SSEEvent>) {
          // Backpressure (C3): yield to the consumer when the queue is full
          // instead of buffering an unbounded fast producer in memory.
          while (controller.desiredSize !== null && controller.desiredSize <= 0) {
            await new Promise((r) => setTimeout(r, 1));
          }
          controller.enqueue(formatSSE(evt));
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}
