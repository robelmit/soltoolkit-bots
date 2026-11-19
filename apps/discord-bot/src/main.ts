/**
 * Starts the bot: reads the settings, opens the store, starts reading the
 * launch feed, registers the slash commands and connects to Discord. Stops
 * cleanly on SIGINT and SIGTERM.
 *
 * discord.js queues and retries on Discord's rate limits itself, so the only
 * pacing here is the buy bot's own (one post per server every ten seconds).
 */

import { AlertEngine, BuyBotEngine, CardLimiter, FeedState, JsonFileStore, detectAddress, firstCall, isDevAlert, keepFeedSnapshot, loadFeedSnapshot, offeredCommands, readJsonl, readRedisStream, toolsFromModule, withTokenFacts, type ChainTools, type Logger, type PostOutcome } from '@soltoolkit/bot-core';
import { Client, DiscordAPIError, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, REST, Routes } from 'discord.js';
import { alertPayload, buyPayload, tokenPayload, type Payload } from './cards';
import { COMMANDS, SLOW_COMMANDS, handleButton, handleCommand, newRefreshGate } from './commands';
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
  if (config.snapshotPath) log.info('tokens taken back from the last run', { tokens: await loadFeedSnapshot(feed, config.snapshotPath).catch(() => 0) });
  // The chain's tools come from the MCP package, loaded only when an endpoint is set.
  let tools: ChainTools | null = null;
  if (config.rpcUrl) {
    const loaded = toolsFromModule(await import('@soltoolkit/mcp'), { rpcUrl: config.rpcUrl, feed });
    tools = loaded.tools;
    if (loaded.reason) log.warn(`/quote, /safety, /holders and /app are off: ${loaded.reason}`);
    else log.info('chain tools on', { tools: tools?.tools.length ?? 0 });
  }
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

  const alerts = new AlertEngine({
    store,
    log,
    creatorOf: (address) => feed.creatorOf(address),
    post: async (community, alert) => {
      // A dev sale goes where the buy bot posts; launches and graduations where the alerts were set.
      const channelId = isDevAlert(alert.kind) ? community.buyBot?.channelId : community.alerts?.channelId;
      if (!channelId) return 'failed';
      const token = await feed.token(alert.address);
      if (!token) return 'dropped';
      const caller = community.calls?.find((c) => c.address === token.address) ?? null;
      const outcome = await send(channelId, alertPayload(alert, token, community, config.links, Date.now(), { rank: await feed.rank(token.address), poweredBy: config.poweredBy, caller }));
      if (outcome === 'gone') {
        // The channel is gone, not the server: those alerts stop and a manager sets them again.
        await store.upsert(community.id, isDevAlert(alert.kind) ? { buyBot: null } : { alerts: null }).catch(() => undefined);
        changed();
        return 'failed';
      }
      return outcome;
    },
  });
  feed.onToken(alerts.onToken);
  feed.onTrade(alerts.onTrade);
  const changed = (): void => {
    engine.invalidate();
    alerts.invalidate();
  };

  client.on(Events.GuildCreate, (guild) => void store.upsert(guild.id, { title: guild.name, left: false }).then(() => log.info('added to server', { guildId: guild.id })));
  client.on(Events.GuildDelete, (guild) => void store.upsert(guild.id, { left: true }).then(() => changed()));

  const gate = newRefreshGate();
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
      try {
        const reply = await handleButton({ customId: interaction.customId, messageId: interaction.message.id, guildId: interaction.guildId }, { source: feed, store, links: config.links, changed: () => undefined, poweredBy: config.poweredBy, gate });
        if (!reply) return;
        if (reply.kind === 'update') await interaction.update(reply.payload);
        else await interaction.reply({ ...reply.payload, flags: MessageFlags.Ephemeral });
      } catch (error) {
        log.warn('a button failed', { button: interaction.customId.slice(0, 2), error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    // A chain read can take longer than the three seconds Discord waits for an answer: it is told to wait first.
    const slow = SLOW_COMMANDS.has(interaction.commandName);
    try {
      if (slow) await interaction.deferReply();
      const reply = await handleCommand(
        {
          name: interaction.commandName,
          guildId: interaction.guildId,
          guildName: interaction.guild?.name ?? null,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          userName: interaction.user.globalName ?? interaction.user.username,
          canManage: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
          address: interaction.options.getString('address'),
          usd: interaction.options.getNumber('usd'),
          channel: interaction.options.getChannel('channel')?.id ?? null,
          mode: interaction.options.getString('mode'),
          minMc: interaction.options.getNumber('min_mc'),
          launchpad: interaction.options.getString('launchpad'),
          amount: interaction.options.getNumber('amount'),
          signature: interaction.options.getString('signature'),
        },
        { source: feed, store, links: config.links, changed, poweredBy: config.poweredBy, tools },
      );
      // A deferred answer cannot turn private, so a refusal after the wait is said in the channel.
      if (slow) await interaction.editReply(reply.payload);
      else await interaction.reply({ ...reply.payload, ...(reply.ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
    } catch (error) {
      log.error('a command failed', { command: interaction.commandName, error: error instanceof Error ? error.message : String(error) });
      const sorry = { content: 'Something went wrong. Try again in a moment.' };
      if (interaction.deferred) await interaction.editReply(sorry).catch(() => undefined);
      else if (!interaction.replied) await interaction.reply({ ...sorry, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  });

  if (config.messageContent) {
    const limiter = new CardLimiter();
    client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot || !message.guildId) return;
      const address = detectAddress(message.content);
      if (!address || !limiter.allow(message.guildId, address)) return;
      const token = await feed.token(address);
      if (!token) return;
      const caller = await firstCall(store, message.guildId, { address, symbol: token.symbol, mc: token.mc }, { id: message.author.id, name: message.author.globalName ?? message.author.username }, Date.now()).catch(() => null);
      await send(message.channelId, tokenPayload(token, config.links, Date.now(), { rank: await feed.rank(address), poweredBy: config.poweredBy, caller }));
    });
  }

  const stop = new AbortController();
  // Saves now and then, and once more as the bot stops, so the next start knows the same tokens.
  const saving = config.snapshotPath ? keepFeedSnapshot(feed, config.snapshotPath, { signal: stop.signal, log }) : Promise.resolve();
  const shutdown = (): void => {
    if (stop.signal.aborted) return;
    log.info('stopping');
    stop.abort();
    void client.destroy();
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

  client.once(Events.ClientReady, (ready) => log.info('bot started', { user: ready.user.tag, servers: ready.guilds.cache.size }));
  await new REST({ version: '10' }).setToken(config.token).put(Routes.applicationCommands(config.applicationId), { body: offeredCommands(COMMANDS, tools) });
  log.info('slash commands registered', { count: offeredCommands(COMMANDS, tools).length });
  void engine.run(stop.signal);
  void alerts.run(stop.signal);
  await client.login(config.token);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
