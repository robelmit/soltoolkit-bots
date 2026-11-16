/**
 * Starts the bot: reads the settings, opens the store, starts reading the
 * launch feed, registers the slash commands and connects to Discord. Stops
 * cleanly on SIGINT and SIGTERM.
 *
 * discord.js queues and retries on Discord's rate limits itself, so the only
 * pacing here is the buy bot's own (one post per server every ten seconds).
 */

import { BuyBotEngine, CardLimiter, FeedState, JsonFileStore, detectAddress, readJsonl, readRedisStream, withTokenFacts, type Logger, type PostOutcome } from '@soltoolkit/bot-core';
import { Client, DiscordAPIError, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, REST, Routes } from 'discord.js';
import { buyPayload, tokenPayload, type Payload } from './cards';
import { COMMANDS, handleCommand } from './commands';
import { readConfig } from './config';

const stamp = (level: string, message: string, fields?: Record<string, unknown>): string => JSON.stringify({ at: new Date().toISOString(), level, message, ...fields });
const log: Logger = {
  info: (message, fields) => console.error(stamp('info', message, fields)),
  warn: (message, fields) => console.error(stamp('warn', message, fields)),
  error: (message, fields) => console.error(stamp('error', message, fields)),
};

/** Discord's answers for a channel the bot can no longer post in: unknown channel, missing access, missing permissions. */
const GONE_CODES = new Set([10003, 50001, 50013]);

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const store = await JsonFileStore.open(config.storePath);
  const feed = new FeedState();
  const client = new Client({ intents: [GatewayIntentBits.Guilds, ...(config.messageContent ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] : [])] });

  const send = async (channelId: string, payload: Payload): Promise<PostOutcome> => {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isSendable()) return 'gone';
      await channel.send(payload);
      return 'sent';
    } catch (error) {
      if (error instanceof DiscordAPIError && typeof error.code === 'number' && GONE_CODES.has(error.code)) return 'gone';
      log.warn('a post failed', { channelId, error: error instanceof Error ? error.message : String(error) });
      return 'failed';
    }
  };

  const engine = new BuyBotEngine({
    store,
    log,
    post: async (community, bare) => {
      if (!bare.config.channelId) return 'failed';
      const post = await withTokenFacts(bare, feed);
      const outcome = await send(bare.config.channelId, buyPayload(post, config.links));
      // The channel is gone, not the server: the buy bot stops there and the server's managers can /track again.
      if (outcome === 'gone') {
        await store.upsert(community.id, { buyBot: null }).catch(() => undefined);
        engine.invalidate();
        return 'failed';
      }
      return outcome;
    },
  });
  feed.onTrade(engine.onTrade);

  client.on(Events.GuildCreate, (guild) => void store.upsert(guild.id, { title: guild.name, left: false }).then(() => log.info('added to server', { guildId: guild.id })));
  client.on(Events.GuildDelete, (guild) => void store.upsert(guild.id, { left: true }).then(() => engine.invalidate()));

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      const reply = await handleCommand(
        {
          name: interaction.commandName,
          guildId: interaction.guildId,
          guildName: interaction.guild?.name ?? null,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          canManage: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
          address: interaction.options.getString('address'),
          usd: interaction.options.getNumber('usd'),
          channel: interaction.options.getChannel('channel')?.id ?? null,
        },
        { source: feed, store, links: config.links, changed: () => engine.invalidate() },
      );
      await interaction.reply({ ...reply.payload, ...(reply.ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
    } catch (error) {
      log.error('a command failed', { command: interaction.commandName, error: error instanceof Error ? error.message : String(error) });
      if (!interaction.replied) await interaction.reply({ content: 'Something went wrong. Try again in a moment.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  });

  if (config.messageContent) {
    const limiter = new CardLimiter();
    client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot || !message.guildId) return;
      const address = detectAddress(message.content);
      if (!address || !limiter.allow(message.guildId, address)) return;
      const token = await feed.token(address);
      if (token) await send(message.channelId, tokenPayload(token, config.links, Date.now()));
    });
  }

  const stop = new AbortController();
  const shutdown = (): void => {
    if (stop.signal.aborted) return;
    log.info('stopping');
    stop.abort();
    void client.destroy();
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

  client.once(Events.ClientReady, (ready) => log.info('bot started', { user: ready.user.tag, servers: ready.guilds.cache.size }));
  await new REST({ version: '10' }).setToken(config.token).put(Routes.applicationCommands(config.applicationId), { body: COMMANDS });
  log.info('slash commands registered', { count: COMMANDS.length });
  void engine.run(stop.signal);
  await client.login(config.token);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
