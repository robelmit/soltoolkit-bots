/**
 * The slash commands, as plain functions of what was asked: no Discord
 * client in here, so every command is tested without a network. `main.ts`
 * turns an interaction into a `CommandInput` and sends the `Payload` back.
 *
 * `/track`, `/minbuy` and `/untrack` need the Manage Server permission, which
 * Discord itself reports on the interaction; it is checked here as well as
 * declared on the command, because a server can change who sees a command.
 */

import { DEFAULT_MIN_BUY_USD, MIN_BUY_USD_RANGE, ago, detectAddress, fmtUsd, shortAddr, type BuyBotConfig, type DataSource, type Line, type LinkTemplates, type Span, type Store } from '@soltoolkit/bot-core';
import { ApplicationCommandOptionType, ChannelType, PermissionFlagsBits, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { note, tokenPayload, trendingPayload, type Payload } from './cards';

const TRENDING_COUNT = 5;
const COVERAGE_WINDOW_MS = 30 * 60_000;
const ADMIN = PermissionFlagsBits.ManageGuild.toString();

/** What is registered with Discord. */
export const COMMANDS: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  { name: 'ca', description: 'A token card', dm_permission: false, options: [{ type: ApplicationCommandOptionType.String, name: 'address', description: 'The token address', required: true }] },
  { name: 'trending', description: 'The most traded launchpad tokens of the last 5 minutes', dm_permission: false },
  {
    name: 'track',
    description: 'Post every buy of a token in a channel',
    dm_permission: false,
    default_member_permissions: ADMIN,
    options: [
      { type: ApplicationCommandOptionType.String, name: 'address', description: 'The token address', required: true },
      { type: ApplicationCommandOptionType.Channel, name: 'channel', description: 'Where the buys are posted (this channel when left out)', channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement] },
    ],
  },
  { name: 'minbuy', description: 'The least buy posted, in USD', dm_permission: false, default_member_permissions: ADMIN, options: [{ type: ApplicationCommandOptionType.Number, name: 'usd', description: 'Dollars, from 1 to 1,000,000', required: true, min_value: MIN_BUY_USD_RANGE.min, max_value: MIN_BUY_USD_RANGE.max }] },
  { name: 'untrack', description: 'Stop the buy bot', dm_permission: false, default_member_permissions: ADMIN },
  { name: 'buybot', description: "The buy bot's settings", dm_permission: false },
  { name: 'help', description: 'What the bot does', dm_permission: false },
];

export interface CommandInput {
  readonly name: string;
  /** The server; null in a direct message. */
  readonly guildId: string | null;
  readonly guildName: string | null;
  readonly channelId: string;
  readonly userId: string;
  /** Whether Discord says the member may manage the server. */
  readonly canManage: boolean;
  readonly address?: string | null;
  readonly usd?: number | null;
  /** The channel option of `/track`, when given. */
  readonly channel?: string | null;
}

export interface CommandReply {
  readonly payload: Payload;
  /** Shown only to the member who asked. */
  readonly ephemeral: boolean;
}

export interface CommandDeps {
  readonly source: DataSource;
  readonly store: Store;
  readonly links: LinkTemplates;
  /** The buy bot's settings changed. */
  readonly changed: () => void;
  readonly now?: () => number;
}

const HELP: Line[] = [
  [{ bold: 'What this bot does' }],
  ['• /ca <address> shows a token card.'],
  ['• /trending lists the most traded launchpad tokens of the last 5 minutes.'],
  ['• Server managers: /track <address> posts every buy of a token in a channel. /minbuy sets the least buy posted, /untrack stops it.'],
  ['The bot reads public chain data. It never trades and never asks for a wallet or a key.'],
];

/** A link to a channel: the shared renderer escapes `<#id>`, and a link opens the channel just the same. */
const channelLink = (guildId: string, channelId: string | null | undefined): Span => (channelId ? { link: 'this channel', url: `https://discord.com/channels/${guildId}/${channelId}` } : 'a channel that was not recorded');

const quiet = (lines: Line[]): CommandReply => ({ payload: note(lines), ephemeral: true });
const aloud = (payload: Payload): CommandReply => ({ payload, ephemeral: false });

export async function handleCommand(input: CommandInput, deps: CommandDeps): Promise<CommandReply> {
  const { source, store, links } = deps;
  const now = (deps.now ?? Date.now)();
  if (!input.guildId) return quiet([['The bot works in a server.']]);
  const guildId = input.guildId;

  const coverage = (address: string): Line => {
    const last = source.lastTradeAt(address);
    if (last !== null && now - last < COVERAGE_WINDOW_MS) return [`✅ Trades of this token are coming in (last ${ago(last, now)} ago).`];
    return ['⏳ No trade of this token seen yet. The feed follows tokens of the launchpads it covers; buys are posted as soon as it sees them.'];
  };
  const managerOnly = (): CommandReply | null => (input.canManage ? null : quiet([['Only a member who can manage the server can do that.']]));
  const noToken = (): CommandReply => quiet([['No token is tracked here. Server managers: /track <address> posts every buy of a token in a channel.']]);

  switch (input.name) {
    case 'help':
      return quiet(HELP);

    case 'ca': {
      const address = detectAddress(input.address ?? '');
      if (!address) return quiet([['That is not a Solana token address.']]);
      const token = await source.token(address);
      if (!token) return quiet([['The feed has not seen ', { code: address }, ' yet. It lists tokens of the launchpads it follows from the moment the bot started.']]);
      return aloud(tokenPayload(token, links, now));
    }

    case 'trending':
      return aloud(trendingPayload(await source.trending(TRENDING_COUNT), links));

    case 'track': {
      const refused = managerOnly();
      if (refused) return refused;
      const address = detectAddress(input.address ?? '');
      if (!address) return quiet([['That is not a Solana token address.']]);
      const token = await source.token(address);
      const current = (await store.get(guildId))?.buyBot ?? null;
      const config: BuyBotConfig = {
        address,
        symbol: token?.symbol ?? null,
        decimals: token && Number.isInteger(token.decimals) ? (token.decimals as number) : null,
        minUsd: current?.minUsd ?? DEFAULT_MIN_BUY_USD,
        channelId: input.channel ?? input.channelId,
        setBy: input.userId,
        setAt: now,
      };
      await store.upsert(guildId, { title: input.guildName, buyBot: config, left: false });
      deps.changed();
      return aloud(
        note([
          ['✅ ', { bold: `Buy bot on for ${config.symbol ?? shortAddr(address)}` }],
          [{ code: address }],
          [`Buys of ${fmtUsd(config.minUsd)} or more are posted in `, channelLink(guildId, config.channelId), ', at most one post every 10 seconds (busy spells are merged).'],
          coverage(address),
        ]),
      );
    }

    case 'minbuy': {
      const refused = managerOnly();
      if (refused) return refused;
      const config = (await store.get(guildId))?.buyBot ?? null;
      if (!config) return noToken();
      const usd = input.usd;
      if (usd === null || usd === undefined || !Number.isFinite(usd) || usd < MIN_BUY_USD_RANGE.min || usd > MIN_BUY_USD_RANGE.max) return quiet([['The least buy is a number of dollars from 1 to 1,000,000.']]);
      const rounded = Math.round(usd * 100) / 100;
      await store.upsert(guildId, { buyBot: { ...config, minUsd: rounded } });
      deps.changed();
      return aloud(note([[`✅ Buys of ${fmtUsd(rounded)} or more are posted.`]]));
    }

    case 'untrack': {
      const refused = managerOnly();
      if (refused) return refused;
      await store.upsert(guildId, { buyBot: null });
      deps.changed();
      return aloud(note([['✅ Buy bot off.']]));
    }

    case 'buybot': {
      const config = (await store.get(guildId))?.buyBot ?? null;
      if (!config) return noToken();
      return quiet([[{ bold: `Buy bot: ${config.symbol ?? shortAddr(config.address)}` }], [{ code: config.address }], [`Least buy posted: ${fmtUsd(config.minUsd)} · Posted in `, channelLink(guildId, config.channelId)], coverage(config.address)]);
    }

    default:
      return quiet([['Unknown command.']]);
  }
}
