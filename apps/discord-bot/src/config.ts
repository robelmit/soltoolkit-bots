/**
 * The bot's settings, read from environment variables. A setting that is
 * missing or malformed stops the bot at start with a sentence that says which
 * one; nothing is guessed.
 */

import { DEFAULT_STREAM_KEY, linkTemplates, parseButtons, type LinkTemplates } from '@soltoolkit/bot-core';

export interface Config {
  readonly token: string;
  readonly applicationId: string;
  /** Where the launch feed is read from. */
  readonly feed: { readonly kind: 'stdin' } | { readonly kind: 'redis'; readonly url: string; readonly key: string };
  /** The JSON file the servers' settings are kept in. */
  readonly storePath: string;
  readonly links: LinkTemplates;
  /**
   * Answer a pasted address without a command. It needs the Message Content intent, which is switched on for the
   * application in the Discord developer portal; off by default.
   */
  readonly messageContent: boolean;
}

export function readConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const get = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };

  const token = get('DISCORD_BOT_TOKEN');
  if (!token) throw new Error('DISCORD_BOT_TOKEN is required: the bot token from the Discord developer portal');
  const applicationId = get('DISCORD_APPLICATION_ID');
  if (!applicationId) throw new Error('DISCORD_APPLICATION_ID is required: the application id from the Discord developer portal');
  if (!/^\d{15,22}$/.test(applicationId)) throw new Error('DISCORD_APPLICATION_ID is a number of 15 to 22 digits');

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

  const content = get('DISCORD_MESSAGE_CONTENT');
  if (content !== undefined && content !== '0' && content !== '1') throw new Error('DISCORD_MESSAGE_CONTENT is 1 or 0');

  const buttons = get('BOT_BUTTONS');
  const links = linkTemplates({
    token: get('LINK_TOKEN'),
    wallet: get('LINK_WALLET'),
    tx: get('LINK_TX'),
    ...(buttons !== undefined ? { buttons: parseButtons(buttons) } : {}),
  });

  return { token, applicationId, feed, storePath: get('STORE_PATH') ?? './data/discord.json', links, messageContent: content === '1' };
}
