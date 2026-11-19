/**
 * The slash commands, as plain functions of what was asked: no Discord
 * client in here, so every command is tested without a network. `main.ts`
 * turns an interaction into a `CommandInput` and sends the `Payload` back.
 *
 * `/track`, `/minbuy` and `/untrack` need the Manage Server permission, which
 * Discord itself reports on the interaction; it is checked here as well as
 * declared on the command, because a server can change who sees a command.
 */

import {
  CardLimiter,
  DEFAULT_LAUNCH_MIN_MC,
  DEFAULT_MIN_BUY_USD,
  LAUNCH_MIN_MC_RANGE,
  MIN_BUY_USD_RANGE,
  QUOTE_NEEDS_FEED,
  ago,
  appCard,
  callsCard,
  detectAddress,
  detectSignature,
  firstCall,
  holdersCard,
  quoteAmountIn,
  quoteCard,
  quoteToolCall,
  quoteViewOf,
  safetyCard,
  toolErrorText,
  type AppView,
  type ChainTools,
  type HoldersView,
  type SafetyView,
  fmtShort,
  fmtUsd,
  launchpadId,
  launchpadLabel,
  shortAddr,
  type AlertConfig,
  type BuyBotConfig,
  type DataSource,
  type Line,
  type LinkTemplates,
  type Span,
  type Store,
} from '@soltoolkit/bot-core';
import { ApplicationCommandOptionType, ChannelType, PermissionFlagsBits, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { COPY_PREFIX, REFRESH_PREFIX, buttonRow, note, tokenPayload, trendingPayload, type Payload } from './cards';

/** A card is redrawn at most once in 15 seconds, and four times a minute. */
export const newRefreshGate = (now: () => number = Date.now): CardLimiter => new CardLimiter(4, 15_000, now);

export interface ButtonInput {
  readonly customId: string;
  /** The message the button is on. */
  readonly messageId: string;
  /** The server, for the card's first call. */
  readonly guildId?: string | null;
}

/** Either the card redrawn in place, or a short answer only the presser sees. */
export type ButtonReply = { readonly kind: 'update'; readonly payload: Payload } | { readonly kind: 'reply'; readonly payload: Payload };

/** Copy CA and Refresh under a token card; null for a button that is not the bot's. */
export async function handleButton(input: ButtonInput, deps: CommandDeps & { readonly gate: CardLimiter }): Promise<ButtonReply | null> {
  const copy = input.customId.startsWith(COPY_PREFIX);
  if (!copy && !input.customId.startsWith(REFRESH_PREFIX)) return null;
  const address = detectAddress(input.customId.slice(2));
  if (!address) return null;
  // The bare address, alone in the message, so a long press on a phone copies exactly it.
  if (copy) return { kind: 'reply', payload: { content: address, allowedMentions: { parse: [] } } };
  if (!deps.gate.allow(input.messageId, address)) return { kind: 'reply', payload: note([['Updated a moment ago. Try again in a few seconds.']]) };
  const token = await deps.source.token(address);
  if (!token) return { kind: 'reply', payload: note([['The feed no longer holds this token, so the card stays as it was.']]) };
  const now = (deps.now ?? Date.now)();
  const caller = input.guildId ? ((await deps.store.get(input.guildId))?.calls?.find((c) => c.address === address) ?? null) : null;
  return { kind: 'update', payload: tokenPayload(token, deps.links, now, { rank: (await deps.source.rank?.(address)) ?? null, poweredBy: deps.poweredBy ?? null, caller }) };
}

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
  { name: 'calls', description: 'The best calls in this server this week', dm_permission: false },
  {
    name: 'quote',
    description: 'What a buy gets, read from the chain',
    dm_permission: false,
    options: [
      { type: ApplicationCommandOptionType.String, name: 'address', description: 'The token address', required: true },
      { type: ApplicationCommandOptionType.Number, name: 'amount', description: 'How much goes in, from 0.001 to 1,000', required: true, min_value: 0.001, max_value: 1_000 },
    ],
  },
  { name: 'safety', description: 'A safety grade read from the chain', dm_permission: false, options: [{ type: ApplicationCommandOptionType.String, name: 'address', description: 'The token address', required: true }] },
  { name: 'holders', description: 'The largest holders and linked groups', dm_permission: false, options: [{ type: ApplicationCommandOptionType.String, name: 'address', description: 'The token address', required: true }] },
  { name: 'app', description: 'Which app placed a trade', dm_permission: false, options: [{ type: ApplicationCommandOptionType.String, name: 'signature', description: 'The transaction signature, or an explorer link to it', required: true }] },
  {
    name: 'launches',
    description: 'Post new launches the first time they reach a market cap',
    dm_permission: false,
    default_member_permissions: ADMIN,
    options: [
      { type: ApplicationCommandOptionType.String, name: 'mode', description: 'On or off', required: true, choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }] },
      { type: ApplicationCommandOptionType.Number, name: 'min_mc', description: 'Market cap in USD (default 20,000)', min_value: LAUNCH_MIN_MC_RANGE.min, max_value: LAUNCH_MIN_MC_RANGE.max },
      { type: ApplicationCommandOptionType.String, name: 'launchpad', description: 'Only this launchpad, such as pump.fun (every launchpad when left out)' },
      { type: ApplicationCommandOptionType.Channel, name: 'channel', description: 'Where the alerts are posted (this channel when left out)', channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement] },
    ],
  },
  {
    name: 'graduations',
    description: 'Post tokens that finish their bonding curve',
    dm_permission: false,
    default_member_permissions: ADMIN,
    options: [
      { type: ApplicationCommandOptionType.String, name: 'mode', description: 'On or off', required: true, choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }] },
      { type: ApplicationCommandOptionType.Channel, name: 'channel', description: 'Where the alerts are posted (this channel when left out)', channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement] },
    ],
  },
  { name: 'help', description: 'What the bot does', dm_permission: false },
];

export interface CommandInput {
  readonly name: string;
  /** The server; null in a direct message. */
  readonly guildId: string | null;
  readonly guildName: string | null;
  readonly channelId: string;
  readonly userId: string;
  /** The member's name as shown, for a first call. */
  readonly userName?: string | null;
  /** Whether Discord says the member may manage the server. */
  readonly canManage: boolean;
  readonly address?: string | null;
  readonly usd?: number | null;
  /** The channel option of `/track`, `/launches` and `/graduations`, when given. */
  readonly channel?: string | null;
  /** `/launches` and `/graduations`. */
  readonly mode?: string | null;
  readonly minMc?: number | null;
  readonly launchpad?: string | null;
  /** `/quote`: how much goes in. `/app`: the transaction. */
  readonly amount?: number | null;
  readonly signature?: string | null;
}

/** The commands that read the chain: Discord is told to wait before they run. */
export const SLOW_COMMANDS: ReadonlySet<string> = new Set(['quote', 'safety', 'holders', 'app']);

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
  /** A credit line for whoever runs the bot, shown at the end of /help. */
  readonly poweredBy?: string | null;
  /** The chain's read-only tools; without them /quote, /safety, /holders and /app say so. */
  readonly tools?: ChainTools | null;
  /** Limits the chain reads per server (default six a minute, the same one once in 30 seconds). */
  readonly toolLimiter?: CardLimiter;
}

const defaultToolLimiter = new CardLimiter(6, 30_000);

const HELP: Line[] = [
  [{ bold: 'What this bot does' }],
  ['• /ca <address> shows a token card. The first card of a token in a server credits whoever called it; /calls ranks the week\'s calls.'],
  ['• /trending lists the most traded launchpad tokens of the last 5 minutes.'],
  ['• Server managers: /track <address> posts every buy of a token in a channel, and warns when its creator sells. /minbuy sets the least buy posted, /untrack stops it.'],
  ['• Server managers: /launches posts new tokens the first time they reach a market cap (default $20K); /graduations posts tokens that finish their curve.'],
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

  /** Reads the chain with one tool and draws its answer; a failure is said only to the asker. */
  const ask = async (key: string, name: string, args: Record<string, unknown>, draw: (data: unknown) => Line[], address: string | null): Promise<CommandReply> => {
    const tools = deps.tools ?? null;
    if (!tools) return quiet([['This bot runs without a chain endpoint, so it cannot read the chain for that. Token cards, trending, calls and alerts work without it.']]);
    if (!tools.tools.includes(name)) return quiet([['That is not available for this chain.']]);
    if (!(deps.toolLimiter ?? defaultToolLimiter).allow(guildId, `${name}:${key}`)) return quiet([['Asked a moment ago. Try again in half a minute.']]);
    try {
      const lines = draw(await tools.run(name, args));
      return aloud({ ...note(lines), components: address ? buttonRow(links, address) : [] });
    } catch (error) {
      return quiet([[`⚠️ ${toolErrorText(error)}`]]);
    }
  };

  switch (input.name) {
    case 'help':
      return quiet(deps.poweredBy ? [...HELP, [deps.poweredBy]] : HELP);

    case 'quote': {
      const address = detectAddress(input.address ?? '');
      if (!address) return quiet([['That is not a Solana token address.']]);
      const token = await source.token(address);
      if (QUOTE_NEEDS_FEED && !token) return quiet([['The feed has not seen this token, so the coin it trades in is unknown.']]);
      const amountIn = quoteAmountIn(String(input.amount ?? ''), token);
      if (!amountIn) return quiet([['The amount is a number from 0.001 to 1,000.']]);
      const call = quoteToolCall(address, amountIn.units);
      return ask(`${address}:${amountIn.units}`, call.name, call.args, (data) => quoteCard(quoteViewOf(data, token), address, links), address);
    }

    case 'safety':
    case 'holders': {
      const address = detectAddress(input.address ?? '');
      if (!address) return quiet([['That is not a Solana token address.']]);
      const token = await source.token(address);
      if (input.name === 'safety') return ask(address, 'token_safety', { mint: address, ...(token?.creator ? { creator: token.creator } : {}) }, (data) => safetyCard(data as SafetyView, token?.symbol ?? null, address, links), address);
      return ask(address, 'holder_map', { mint: address, walk: 10 }, (data) => holdersCard(data as HoldersView, token?.symbol ?? null, address, links), address);
    }

    case 'app': {
      const signature = detectSignature(input.signature ?? '');
      if (!signature) return quiet([['That is not a transaction signature or a link to one.']]);
      return ask(signature, 'identify_trading_app', { signature }, (data) => appCard(data as AppView, links), null);
    }

    case 'ca': {
      const address = detectAddress(input.address ?? '');
      if (!address) return quiet([['That is not a Solana token address.']]);
      const token = await source.token(address);
      if (!token) return quiet([['The feed has not seen ', { code: address }, ' yet. It lists tokens of the launchpads it follows from the moment the bot started.']]);
      const caller = await firstCall(store, guildId, { address, symbol: token.symbol, mc: token.mc }, { id: input.userId, name: input.userName ?? 'someone' }, now).catch(() => null);
      return aloud(tokenPayload(token, links, now, { rank: (await source.rank?.(address)) ?? null, poweredBy: deps.poweredBy ?? null, caller }));
    }

    case 'calls':
      return aloud({ ...note(await callsCard((await store.get(guildId))?.calls ?? [], source, links, now)) });

    case 'launches':
    case 'graduations': {
      const refused = managerOnly();
      if (refused) return refused;
      const on = input.mode === 'on';
      const current = (await store.get(guildId))?.alerts ?? null;
      let launches: AlertConfig['launches'] = current?.launches ?? null;
      let graduations: AlertConfig['graduations'] = current?.graduations ?? null;
      let said: string;
      if (input.name === 'launches') {
        if (!on) {
          launches = null;
          said = '✅ Launch alerts off.';
        } else {
          const minMc = input.minMc ?? DEFAULT_LAUNCH_MIN_MC;
          if (minMc < LAUNCH_MIN_MC_RANGE.min || minMc > LAUNCH_MIN_MC_RANGE.max) return quiet([[`The market cap is from $${fmtShort(LAUNCH_MIN_MC_RANGE.min)} to $${fmtShort(LAUNCH_MIN_MC_RANGE.max)}.`]]);
          const launchpad = input.launchpad ? launchpadId(input.launchpad) : null;
          if (input.launchpad && !launchpad) return quiet([[`"${input.launchpad.slice(0, 40)}" is not a launchpad this bot knows.`]]);
          launches = { minMc, launchpad };
          said = `✅ New launches are posted the first time they reach $${fmtShort(minMc)}${launchpad ? ` on ${launchpadLabel(launchpad)}` : ''}: tokens younger than an hour, at most one a minute.`;
        }
      } else {
        graduations = on ? { on: true } : null;
        said = on ? '✅ Tokens that finish their bonding curve are posted, at most one a minute.' : '✅ Graduation alerts off.';
      }
      const channelId = input.channel ?? current?.channelId ?? input.channelId;
      await store.upsert(guildId, { title: input.guildName, left: false, alerts: { launches, graduations, channelId, setBy: input.userId, setAt: now } });
      deps.changed();
      return quiet([[said], ...(launches || graduations ? [['Alerts go to ', channelLink(guildId, channelId), '.'] as Line] : [])]);
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
