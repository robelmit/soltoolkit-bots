/**
 * The bot's settings, read from environment variables. A setting that is
 * missing or malformed stops the bot at start with a sentence that says which
 * one; nothing is guessed.
 */

import { DEFAULT_STREAM_KEY, linkTemplates, parseButtons, type LinkTemplates } from '@soltoolkit/bot-core';

export interface Config {
  readonly token: string;
  /** Where the launch feed is read from. */
  readonly feed: { readonly kind: 'stdin' } | { readonly kind: 'redis'; readonly url: string; readonly key: string };
  /** The JSON file the groups' settings are kept in. */
  readonly storePath: string;
  readonly links: LinkTemplates;
  /** A credit line for whoever runs the bot, shown at the end of the welcome and /help. */
  readonly poweredBy: string | null;
}

export function readConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const get = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };

  const token = get('TELEGRAM_BOT_TOKEN');
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required: the token BotFather gave for the bot');
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('TELEGRAM_BOT_TOKEN does not look like a bot token (digits, a colon, then the secret)');

  const kind = get('FEED') ?? (get('REDIS_URL') ? 'redis' : 'stdin');
  let feed: Config['feed'];
  if (kind === 'stdin') {
    feed = { kind: 'stdin' };
  } else if (kind === 'redis') {
    const url = get('REDIS_URL');
    if (!url) throw new Error('REDIS_URL is required with FEED=redis');
    if (!/^rediss?:\/\//.test(url)) throw new Error('REDIS_URL must start with redis:// or rediss://');
    feed = { kind: 'redis', url, key: get('FEED_STREAM_KEY') ?? DEFAULT_STREAM_KEY };
  } else {
    throw new Error(`FEED is "${kind}": use stdin or redis`);
  }

  const buttons = get('BOT_BUTTONS');
  const links = linkTemplates({
    token: get('LINK_TOKEN'),
    wallet: get('LINK_WALLET'),
    tx: get('LINK_TX'),
    ...(buttons !== undefined ? { buttons: parseButtons(buttons) } : {}),
  });

  const poweredBy = get('BOT_POWERED_BY') ?? null;
  if (poweredBy !== null && poweredBy.length > 120) throw new Error('BOT_POWERED_BY is at most 120 characters');

  return { token, feed, storePath: get('STORE_PATH') ?? './data/telegram.json', links, poweredBy };
}
