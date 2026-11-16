/**
 * Two ways to read the launch feed: lines of JSON (the feed's standard
 * output, piped in or read from a file), and a Redis Stream. Neither pulls in
 * a dependency: the Redis reader takes any client with an `xread` method
 * (ioredis has one).
 */

import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { parseFeedEvent } from './feed';
import type { FeedEvent, Logger } from './types';
import { silentLogger } from './types';

/** Reads events from lines of JSON until the input ends or `signal` aborts. Lines that are not events are skipped. */
export async function readJsonl(input: Readable, onEvent: (event: FeedEvent) => void, signal?: AbortSignal): Promise<{ lines: number; events: number }> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const stop = (): void => lines.close();
  signal?.addEventListener('abort', stop, { once: true });
  let read = 0;
  let events = 0;
  try {
    for await (const line of lines) {
      if (signal?.aborted) break;
      read += 1;
      const event = parseFeedEvent(line);
      if (!event) continue;
      events += 1;
      onEvent(event);
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  return { lines: read, events };
}

/** The one Redis command the reader needs; ioredis fits as it is. */
export interface RedisStreamClient {
  xread(...args: (string | number)[]): Promise<unknown>;
}

export interface RedisStreamOptions {
  /** The stream key (default `stream:market:solana`). */
  readonly key?: string;
  /** Where to start: `$` for new entries only (the default), `0` for everything kept, or an entry id. */
  readonly from?: string;
  /** How long one read waits for entries, in milliseconds (default 5,000). */
  readonly blockMs?: number;
  /** Entries per read (default 500). */
  readonly count?: number;
  readonly log?: Logger;
  /** Wait between retries after a failed read, in milliseconds (default 2,000). */
  readonly retryMs?: number;
}

export const DEFAULT_STREAM_KEY = 'stream:market:solana';

/** The `payload` field of one stream entry's flat field list. */
function payloadOf(fields: unknown): string | null {
  if (!Array.isArray(fields)) return null;
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === 'payload' && typeof fields[i + 1] === 'string') return fields[i + 1] as string;
  return null;
}

/**
 * Reads the feed's Redis Stream until `signal` aborts. A plain `XREAD`: every bot process gets every entry, and a
 * restart continues from "now", so nothing old is replayed into a group. A failed read is logged and tried again.
 */
export async function readRedisStream(client: RedisStreamClient, onEvent: (event: FeedEvent) => void, signal: AbortSignal, options: RedisStreamOptions = {}): Promise<void> {
  const key = options.key ?? DEFAULT_STREAM_KEY;
  const log = options.log ?? silentLogger;
  const blockMs = options.blockMs ?? 5_000;
  const count = options.count ?? 500;
  let id = options.from ?? '$';
  while (!signal.aborted) {
    let reply: unknown;
    try {
      reply = await client.xread('COUNT', count, 'BLOCK', blockMs, 'STREAMS', key, id);
    } catch (error) {
      if (signal.aborted) return;
      log.warn('feed: the stream could not be read; trying again', { key, error: error instanceof Error ? error.message : String(error) });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.retryMs ?? 2_000);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      continue;
    }
    if (!Array.isArray(reply)) continue;
    for (const stream of reply) {
      if (!Array.isArray(stream) || !Array.isArray(stream[1])) continue;
      for (const entry of stream[1]) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
        id = entry[0];
        const payload = payloadOf(entry[1]);
        const event = payload === null ? null : parseFeedEvent(payload);
        if (event) onEvent(event);
      }
    }
  }
}
