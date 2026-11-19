/**
 * Starts the bot: reads the settings, opens the store, starts reading the
 * launch feed (lines on standard input, or a Redis Stream), and polls
 * Telegram for updates. Stops cleanly on SIGINT and SIGTERM.
 */

import { FeedState, JsonFileStore, keepFeedSnapshot, loadFeedSnapshot, readJsonl, readRedisStream, type Logger } from '@soltoolkit/bot-core';
import { COMMANDS, createBot } from './bot';
import { readConfig } from './config';

const stamp = (level: string, message: string, fields?: Record<string, unknown>): string => JSON.stringify({ at: new Date().toISOString(), level, message, ...fields });
const log: Logger = {
  info: (message, fields) => console.error(stamp('info', message, fields)),
  warn: (message, fields) => console.error(stamp('warn', message, fields)),
  error: (message, fields) => console.error(stamp('error', message, fields)),
};

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const store = await JsonFileStore.open(config.storePath);
  const feed = new FeedState();
  if (config.snapshotPath) log.info('tokens taken back from the last run', { tokens: await loadFeedSnapshot(feed, config.snapshotPath).catch(() => 0) });
  const { bot, engine, alerts } = createBot({ token: config.token, source: feed, store, links: config.links, log, poweredBy: config.poweredBy, cardImage: config.cardImage });
  feed.onTrade(engine.onTrade);
  feed.onToken(alerts.onToken);
  feed.onTrade(alerts.onTrade);

  const stop = new AbortController();
  // Saves now and then, and once more as the bot stops, so the next start knows the same tokens.
  const saving = config.snapshotPath ? keepFeedSnapshot(feed, config.snapshotPath, { signal: stop.signal, log }) : Promise.resolve();
  const shutdown = (): void => {
    if (stop.signal.aborted) return;
    log.info('stopping');
    stop.abort();
    void bot.stop();
    void saving.then(() => log.info('tokens saved for the next start'));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (config.feed.kind === 'redis') {
    const { Redis } = await import('ioredis');
    const redis = new Redis(config.feed.url, { maxRetriesPerRequest: null });
    redis.on('error', (error: Error) => log.warn('redis', { error: error.message }));
    stop.signal.addEventListener('abort', () => redis.disconnect(), { once: true });
    void readRedisStream(redis as unknown as Parameters<typeof readRedisStream>[0], (event) => feed.apply(event), stop.signal, { key: config.feed.key, log });
    log.info('reading the feed from Redis', { key: config.feed.key });
  } else {
    void readJsonl(process.stdin, (event) => feed.apply(event), stop.signal).then((result) => log.info('the feed on standard input ended', result));
    log.info('reading the feed from standard input');
  }

  void engine.run(stop.signal);
  void alerts.run(stop.signal);
  await bot.api.setMyCommands([...COMMANDS]).catch((error: unknown) => log.warn('the command menu could not be set', { error: error instanceof Error ? error.message : String(error) }));
  await bot.start({
    // callback_query carries the Refresh button's presses.
    allowed_updates: ['message', 'my_chat_member', 'callback_query'],
    onStart: (me) => log.info('bot started', { username: me.username }),
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
