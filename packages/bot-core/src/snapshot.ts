/**
 * The tokens a bot knows, kept across restarts. The feed sends a token's
 * listing once and then only changes, so a bot that restarts would otherwise
 * know only the tokens listed after it started. The snapshot is written now
 * and then and at shutdown, through a temporary file swapped into place, and
 * read at start when it is less than a day old.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FeedSnapshot, FeedState } from './feed';
import type { Logger } from './types';
import { silentLogger } from './types';

/** Writes the snapshot of `state` to `path`. */
export async function saveFeedSnapshot(state: FeedState, path: string): Promise<number> {
  const snapshot = state.exportSnapshot();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), 'utf8');
  await rename(temporary, path);
  return snapshot.tokens.length;
}

/** Reads the snapshot at `path` into `state`; a missing file is no snapshot. Returns how many tokens came back. */
export async function loadFeedSnapshot(state: FeedState, path: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let snapshot: FeedSnapshot;
  try {
    snapshot = JSON.parse(text) as FeedSnapshot;
  } catch {
    // A file that does not parse is a snapshot cut short; the feed fills the bot again.
    return 0;
  }
  return state.importSnapshot(snapshot);
}

/** Saves the snapshot every `everyMs` (default five minutes) and once more when `signal` aborts. */
export async function keepFeedSnapshot(state: FeedState, path: string, options: { readonly signal: AbortSignal; readonly everyMs?: number; readonly log?: Logger }): Promise<void> {
  const log = options.log ?? silentLogger;
  const save = async (): Promise<void> => {
    try {
      await saveFeedSnapshot(state, path);
    } catch (error) {
      log.warn('the token snapshot could not be saved', { error: error instanceof Error ? error.message : String(error) });
    }
  };
  while (!options.signal.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.everyMs ?? 5 * 60_000);
      options.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
    await save();
  }
}
