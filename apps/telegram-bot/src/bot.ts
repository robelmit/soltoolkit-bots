/**
 * The Telegram bot. In a group it answers a pasted token address (or
 * `/ca <address>`) with a token card, lists the movers with `/trending`, and
 * runs a buy bot the group's admins set up with `/track`. It never trades,
 * holds no keys and asks nobody for a wallet.
 *
 * With Telegram's privacy mode on (BotFather's default) a bot only sees
 * commands and mentions, so pasted addresses go unanswered until the operator
 * turns privacy off (`/setprivacy` → Disable) or a group makes the bot an
 * admin; `/ca` works either way.
 *
 * Admin commands are checked with `getChatMember`, never trusted from the
 * message.
 */

import {
  AlertEngine,
  BuyBotEngine,
  CardLimiter,
  DEFAULT_MIN_BUY_USD,
  alertCard,
  callsCard,
  QUOTE_NEEDS_FEED,
  appCard,
  detectSignature,
  firstCall,
  holdersCard,
  isDevAlert,
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
  launchpadLabel,
  parseLaunchArgs,
  type Call,
  MIN_BUY_USD_RANGE,
  ago,
  buttonsFor,
  buyPostCard,
  detectAddress,
  fmtUsd,
  parseUsd,
  shortAddr,
  silentLogger,
  tokenCard,
  toMarkdownV2,
  toPlain,
  trendingCard,
  withTokenFacts,
  type BuyBotConfig,
  type CommunityRecord,
  type DataSource,
  type Line,
  type LinkButton,
  type LinkTemplates,
  type Logger,
  type Store,
  type TokenView,
} from '@soltoolkit/bot-core';
import { Bot, GrammyError, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { MD, Outbox, REFRESH_PREFIX, isParseError, keyboardOf, previewOf, type CardActions, type OutboxLimits } from './outbox';

export interface BotOptions {
  readonly token: string;
  readonly source: DataSource;
  readonly store: Store;
  readonly links: LinkTemplates;
  readonly log?: Logger;
  readonly now?: () => number;
  /** Given in tests so the bot does not ask Telegram who it is. */
  readonly botInfo?: UserFromGetMe;
  readonly limits?: Partial<OutboxLimits>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** A credit line for whoever runs the bot, shown at the end of the welcome and /help (`BOT_POWERED_BY`). */
  readonly poweredBy?: string | null;
  /** Show the token's picture small above a card (`BOT_CARD_IMAGE=1`). */
  readonly cardImage?: boolean;
  /** The chain's read-only tools (`/quote`, `/safety`, `/holders`, `/app`); without them those commands say so. */
  readonly tools?: ChainTools | null;
}

export interface TelegramBot {
  readonly bot: Bot;
  readonly engine: BuyBotEngine;
  readonly alerts: AlertEngine;
  readonly outbox: Outbox;
}

/** The commands shown in Telegram's menu. */
export const COMMANDS = [
  { command: 'ca', description: 'Token card: /ca <address>' },
  { command: 'trending', description: 'Most traded in the last 5 minutes' },
  { command: 'calls', description: 'The best calls in this group this week' },
  { command: 'quote', description: 'What a buy gets: /quote <address> <amount>' },
  { command: 'safety', description: 'A safety grade from the chain: /safety <address>' },
  { command: 'holders', description: 'The largest holders and linked groups: /holders <address>' },
  { command: 'app', description: 'Which app placed a trade: /app <transaction>' },
  { command: 'track', description: 'Admins: post every buy of a token here' },
  { command: 'minbuy', description: 'Admins: the least buy posted, in USD' },
  { command: 'buymedia', description: 'Admins: reply to a picture or GIF to post it with buys' },
  { command: 'untrack', description: 'Admins: stop the buy bot' },
  { command: 'buybot', description: "The buy bot's settings" },
  { command: 'launches', description: 'Admins: post new launches past a market cap' },
  { command: 'graduations', description: 'Admins: post tokens that finish their curve' },
  { command: 'help', description: 'What the bot does' },
] as const;

/** Telegram's sender for an anonymous group admin posting as the group. */
const GROUP_ANONYMOUS_BOT = 1_087_968_824;
/** A token with a trade this recent is being followed by the feed. */
const COVERAGE_WINDOW_MS = 30 * 60_000;
const TRENDING_COUNT = 5;

const HELP: Line[] = [
  [{ bold: 'What this bot does' }],
  ['• Paste a token address, or send /ca <address>, for a token card. The first card of a token in a group credits whoever called it; /calls ranks the week\'s calls.'],
  ['• /trending lists the most traded launchpad tokens of the last 5 minutes.'],
  ['• /quote <address> <amount> says what a buy gets; /safety, /holders and /app read the chain for a grade, the largest holders, or the app behind a trade.'],
  ['• Admins: /track <address> posts every buy of a token here, and warns when its creator sells. /minbuy <usd> sets the least buy posted, /buymedia adds a picture, /untrack stops it.'],
  ['• Admins: /launches on [market cap] [launchpad] posts new tokens the first time they reach a market cap (default $20K). /graduations on posts tokens that finish their curve. "off" stops either.'],
  ['The bot reads public chain data. It never trades and never asks for a wallet or a key.'],
];

const ADMIN_ONLY: Line[] = [['Only a group admin can do that.']];
const GROUPS_ONLY: Line[] = [['The buy bot works in a group: add me to one, then an admin sends /track <address> there.']];
const NO_TOKEN: Line[] = [['No token is tracked here. Admins: /track <address> posts every buy of a token in this group.']];

const isGroup = (ctx: Context): boolean => ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
const chatKey = (ctx: Context): string => String(ctx.chat?.id ?? '');
const argOf = (ctx: Context): string => (typeof ctx.match === 'string' ? ctx.match.trim() : '');

export function createBot(options: BotOptions): TelegramBot {
  const { source, store, links } = options;
  const log = options.log ?? silentLogger;
  const now = options.now ?? Date.now;
  const bot = new Bot(options.token, options.botInfo ? { botInfo: options.botInfo } : {});
  const outbox = new Outbox(bot.api, { limits: options.limits, now, sleep: options.sleep });
  const limiter = new CardLimiter(10, 120_000, now);
  const help: readonly Line[] = options.poweredBy ? [...HELP, [options.poweredBy]] : HELP;

  const engine = new BuyBotEngine({
    store,
    log,
    now,
    post: async (community, bare) => {
      const post = await withTokenFacts(bare, source);
      const lines = buyPostCard(post, links);
      const send = { kind: 'buy', buttons: buttonsFor(links, post.config.address), maxWaitMs: 5_000 };
      const media = post.config.media ?? null;
      let result = media ? await outbox.media(community.id, media, lines, send) : await outbox.text(community.id, lines, send);
      // A group that keeps media from members refuses the picture: the post goes as text.
      if (media && result.outcome === 'failed') result = await outbox.text(community.id, lines, send);
      return result.outcome;
    },
  });

  /** A direct reply to a command, with the plain-text fallback when Telegram refuses the markup. */
  const reply = async (ctx: Context, lines: readonly Line[], buttons?: readonly LinkButton[], extra: { actions?: CardActions; previewUrl?: string | null } = {}): Promise<void> => {
    const keyboard = keyboardOf(buttons, extra.actions);
    const markup = keyboard ? { reply_markup: keyboard } : {};
    const preview = previewOf(extra.previewUrl);
    try {
      await ctx.reply(toMarkdownV2(lines), { ...MD, ...preview, ...markup });
    } catch (error) {
      if (!isParseError(error)) throw error;
      log.warn('markdown refused, sent plain', { chat: chatKey(ctx) });
      await ctx.reply(toPlain(lines), { ...preview, ...markup });
    }
  };

  /** A token's card with its rank, its first call in this chat, its buttons and, when asked for, its picture. */
  const cardOf = async (token: TokenView, caller: Call | null = null): Promise<{ lines: Line[]; buttons: LinkButton[]; actions: CardActions; previewUrl: string | null }> => ({
    lines: tokenCard(token, links, now(), { rank: (await source.rank?.(token.address)) ?? null, caller }),
    buttons: buttonsFor(links, token.address),
    actions: { copy: token.address, refresh: token.address },
    previewUrl: options.cardImage ? (token.image ?? null) : null,
  });

  /** The chat's call of a token, noting this one when it is the first; none outside groups. */
  const callOf = async (ctx: Context, token: TokenView): Promise<Call | null> => {
    if (!isGroup(ctx) || !ctx.from || ctx.from.id === GROUP_ANONYMOUS_BOT) return null;
    const name = ctx.from.username ?? [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    return firstCall(store, chatKey(ctx), { address: token.address, symbol: token.symbol, mc: token.mc }, { id: String(ctx.from.id), name }, now()).catch((error: unknown) => {
      log.warn('a call could not be noted', { chat: chatKey(ctx), error: error instanceof Error ? error.message : String(error) });
      return null;
    });
  };

  const alerts = new AlertEngine({
    store,
    log,
    now,
    creatorOf: source.creatorOf ? (address) => source.creatorOf!(address) : undefined,
    post: async (community, alert) => {
      const token = await source.token(alert.address);
      if (!token) return 'dropped';
      const caller = community.calls?.find((c) => c.address === token.address) ?? null;
      const lines = alertCard(alert, token, community, links, now(), { rank: (await source.rank?.(token.address)) ?? null, caller });
      const result = await outbox.text(community.id, lines, { kind: alert.kind, buttons: buttonsFor(links, token.address), actions: { copy: token.address, refresh: isDevAlert(alert.kind) ? undefined : token.address }, maxWaitMs: 5_000 });
      return result.outcome;
    },
  });
  /** Settings changed: both engines read them again. */
  const changed = (): void => {
    engine.invalidate();
    alerts.invalidate();
  };

  /** A card is redrawn at most once in 15 seconds, and four times a minute. */
  const refreshGate = new CardLimiter(4, 15_000, now);

  /** Whether the sender is the group's creator or one of its administrators, by Telegram's own word. */
  const isAdmin = async (ctx: Context): Promise<boolean> => {
    const from = ctx.from;
    if (!from || !isGroup(ctx)) return false;
    if (from.id === GROUP_ANONYMOUS_BOT && ctx.message?.sender_chat?.id === ctx.chat?.id) return true;
    try {
      const member = await ctx.getChatMember(from.id);
      return member.status === 'creator' || member.status === 'administrator';
    } catch (error) {
      log.warn('getChatMember failed', { chat: chatKey(ctx), error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  /** True when the command may go on; otherwise the reason was already said. */
  const adminInGroup = async (ctx: Context): Promise<boolean> => {
    if (!isGroup(ctx)) {
      await reply(ctx, GROUPS_ONLY);
      return false;
    }
    if (await isAdmin(ctx)) return true;
    await reply(ctx, ADMIN_ONLY);
    return false;
  };

  const titleOf = (ctx: Context): string | null => (ctx.chat && 'title' in ctx.chat ? (ctx.chat.title ?? null) : null);
  const recordOf = async (ctx: Context): Promise<CommunityRecord | null> => store.get(chatKey(ctx));

  const coverageLine = (address: string): Line => {
    const last = source.lastTradeAt(address);
    if (last !== null && now() - last < COVERAGE_WINDOW_MS) return [`✅ Trades of this token are coming in (last ${ago(last, now())} ago).`];
    return ['⏳ No trade of this token seen yet. The feed follows tokens of the launchpads it covers; buys are posted as soon as it sees them.'];
  };

  // ---- membership ----------------------------------------------------------

  bot.on('my_chat_member', async (ctx) => {
    if (!isGroup(ctx)) return;
    const was = ctx.myChatMember.old_chat_member.status;
    const is = ctx.myChatMember.new_chat_member.status;
    if (is === 'left' || is === 'kicked') {
      await store.upsert(chatKey(ctx), { title: titleOf(ctx), left: true });
      changed();
      log.info('left group', { chat: chatKey(ctx) });
      return;
    }
    await store.upsert(chatKey(ctx), { title: titleOf(ctx), left: false });
    if (was === 'left' || was === 'kicked') {
      log.info('added to group', { chat: chatKey(ctx) });
      await reply(ctx, help).catch((error: unknown) => log.warn('welcome failed', { chat: chatKey(ctx), error: error instanceof Error ? error.message : String(error) }));
    }
  });

  // A group upgraded to a supergroup gets a new chat id. Telegram says so in both chats; whichever arrives first
  // moves the settings, the other finds nothing left to move.
  bot.on('message:migrate_to_chat_id', async (ctx) => {
    await store.migrate(chatKey(ctx), String(ctx.message.migrate_to_chat_id));
    changed();
  });
  bot.on('message:migrate_from_chat_id', async (ctx) => {
    await store.migrate(String(ctx.message.migrate_from_chat_id), chatKey(ctx));
    changed();
  });

  // ---- cards ---------------------------------------------------------------

  async function card(ctx: Context, text: string, explicit: boolean): Promise<void> {
    const address = detectAddress(text);
    if (!address) {
      if (explicit) await reply(ctx, [['Send /ca <token address>.']]);
      return;
    }
    // A card nobody asked for by command is rate-limited per chat, so a busy group is not flooded.
    if (!explicit && !limiter.allow(chatKey(ctx), address)) return;
    const token = await source.token(address);
    if (!token) {
      if (explicit) await reply(ctx, [['The feed has not seen ', { code: address }, ' yet. It lists tokens of the launchpads it follows from the moment the bot started.']]);
      return;
    }
    const { lines, buttons, actions, previewUrl } = await cardOf(token, await callOf(ctx, token));
    if (explicit) return void (await reply(ctx, lines, buttons, { actions, previewUrl }));
    // The bot handles updates one at a time, so an unasked card waits at most 1.5 s for a slot and is dropped past it.
    const result = await outbox.text(chatKey(ctx), lines, { kind: 'card', buttons, actions, previewUrl, maxWaitMs: 1_500 });
    if (result.outcome === 'gone') await store.upsert(chatKey(ctx), { left: true }).catch(() => undefined);
  }

  bot.command(['ca', 't'], async (ctx) => card(ctx, argOf(ctx), true));

  // Refresh under a card: the same message, redrawn with what the feed knows now.
  bot.callbackQuery(new RegExp(`^${REFRESH_PREFIX}(.+)$`), async (ctx) => {
    const address = detectAddress(ctx.match[1] ?? '');
    const message = ctx.callbackQuery.message;
    if (!address || !message) return void (await ctx.answerCallbackQuery());
    if (!refreshGate.allow(`${message.chat.id}:${message.message_id}`, address)) return void (await ctx.answerCallbackQuery({ text: 'Updated a moment ago. Try again in a few seconds.' }));
    const token = await source.token(address);
    if (!token) return void (await ctx.answerCallbackQuery({ text: 'The feed no longer holds this token, so the card stays as it was.' }));
    const caller = (await store.get(String(message.chat.id)))?.calls?.find((c) => c.address === address) ?? null;
    const { lines, buttons, actions, previewUrl } = await cardOf(token, caller);
    const keyboard = keyboardOf(buttons, actions);
    const markup = keyboard ? { reply_markup: keyboard } : {};
    const preview = previewOf(previewUrl);
    try {
      try {
        await ctx.editMessageText(toMarkdownV2(lines), { ...MD, ...preview, ...markup });
      } catch (error) {
        if (!isParseError(error)) throw error;
        await ctx.editMessageText(toPlain(lines), { ...preview, ...markup });
      }
    } catch (error) {
      // Nothing changed since the last draw: Telegram refuses the edit, and the card is already current.
      if (!(error instanceof GrammyError && /message is not modified/i.test(error.description))) throw error;
    }
    await ctx.answerCallbackQuery({ text: 'Updated' });
  });

  bot.command('trending', async (ctx) => {
    await reply(ctx, trendingCard(await source.trending(TRENDING_COUNT), links));
  });

  // ---- the buy bot ---------------------------------------------------------

  bot.command('track', async (ctx) => {
    if (!(await adminInGroup(ctx))) return;
    const address = detectAddress(argOf(ctx));
    if (!address) return void (await reply(ctx, [['Send /track <token address>. The bot then posts every buy of it here.']]));
    const token = await source.token(address);
    const current = (await recordOf(ctx))?.buyBot ?? null;
    const config: BuyBotConfig = {
      address,
      symbol: token?.symbol ?? null,
      decimals: token && Number.isInteger(token.decimals) ? (token.decimals as number) : null,
      minUsd: current?.minUsd ?? DEFAULT_MIN_BUY_USD,
      media: current?.media ?? null,
      setBy: String(ctx.from?.id ?? ''),
      setAt: now(),
    };
    // A command in the group means the bot is in it, whatever an earlier failed post concluded.
    await store.upsert(chatKey(ctx), { title: titleOf(ctx), buyBot: config, left: false });
    changed();
    log.info('buy bot on', { chat: chatKey(ctx), address, minUsd: config.minUsd });
    await reply(ctx, [
      ['✅ ', { bold: `Buy bot on for ${config.symbol ?? shortAddr(address)}` }],
      [{ code: address }],
      [`Buys of ${fmtUsd(config.minUsd)} or more are posted here, at most one post every 10 seconds (busy spells are merged).`],
      coverageLine(address),
      ['/minbuy <usd> · /buymedia (reply to a picture or GIF) · /untrack'],
    ]);
  });

  bot.command('untrack', async (ctx) => {
    if (!(await adminInGroup(ctx))) return;
    await store.upsert(chatKey(ctx), { buyBot: null });
    changed();
    await reply(ctx, [['✅ Buy bot off.']]);
  });

  bot.command('minbuy', async (ctx) => {
    if (!isGroup(ctx)) return void (await reply(ctx, GROUPS_ONLY));
    const config = (await recordOf(ctx))?.buyBot ?? null;
    if (!config) return void (await reply(ctx, NO_TOKEN));
    const arg = argOf(ctx);
    if (!arg) return void (await reply(ctx, [[`Buys of ${fmtUsd(config.minUsd)} or more are posted. Admins change it with /minbuy <usd>.`]]));
    if (!(await adminInGroup(ctx))) return;
    const usd = parseUsd(arg);
    if (usd === null || usd < MIN_BUY_USD_RANGE.min || usd > MIN_BUY_USD_RANGE.max) return void (await reply(ctx, [['The least buy is a number of dollars from 1 to 1,000,000.']]));
    await store.upsert(chatKey(ctx), { buyBot: { ...config, minUsd: usd } });
    changed();
    await reply(ctx, [[`✅ Buys of ${fmtUsd(usd)} or more are posted.`]]);
  });

  bot.command('buymedia', async (ctx) => {
    if (!(await adminInGroup(ctx))) return;
    const config = (await recordOf(ctx))?.buyBot ?? null;
    if (!config) return void (await reply(ctx, NO_TOKEN));
    if (argOf(ctx).toLowerCase() === 'off') {
      await store.upsert(chatKey(ctx), { buyBot: { ...config, media: null } });
      changed();
      return void (await reply(ctx, [['✅ Buy posts are text only now.']]));
    }
    const replied = ctx.message?.reply_to_message;
    const photo = replied?.photo?.at(-1)?.file_id ?? null;
    const animation = replied?.animation?.file_id ?? null;
    if (!photo && !animation) return void (await reply(ctx, [['Reply to a picture or a GIF with /buymedia to post it with every buy; /buymedia off removes it.']]));
    await store.upsert(chatKey(ctx), { buyBot: { ...config, media: animation ? { kind: 'animation', fileId: animation } : { kind: 'photo', fileId: photo! } } });
    changed();
    await reply(ctx, [[`✅ Buy posts now carry this ${animation ? 'GIF' : 'picture'}.`]]);
  });

  bot.command('buybot', async (ctx) => {
    if (!isGroup(ctx)) return void (await reply(ctx, GROUPS_ONLY));
    const config = (await recordOf(ctx))?.buyBot ?? null;
    if (!config) return void (await reply(ctx, NO_TOKEN));
    await reply(ctx, [
      [{ bold: `Buy bot: ${config.symbol ?? shortAddr(config.address)}` }],
      [{ code: config.address }],
      [`Least buy posted: ${fmtUsd(config.minUsd)} · Picture: ${config.media ? (config.media.kind === 'animation' ? 'GIF' : 'picture') : 'none'}`],
      coverageLine(config.address),
    ]);
  });

  // ---- the chain's tools ---------------------------------------------------

  const tools = options.tools ?? null;
  /** Reads the chain; a chat asks at most six a minute, and the same thing once in 30 seconds. */
  const toolLimiter = new CardLimiter(6, 30_000, now);
  const NO_TOOLS: Line[] = [['This bot runs without a chain endpoint, so it cannot read the chain for that. Token cards, trending, calls and alerts work without it.']];

  const ask = async (ctx: Context, key: string, name: string, args: Record<string, unknown>, draw: (data: unknown) => Line[], buttons?: readonly LinkButton[]): Promise<void> => {
    if (!tools) return void (await reply(ctx, NO_TOOLS));
    if (!tools.tools.includes(name)) return void (await reply(ctx, [['That is not available for this chain.']]));
    if (!toolLimiter.allow(chatKey(ctx), `${name}:${key}`)) return void (await reply(ctx, [['Asked a moment ago. Try again in half a minute.']]));
    let data: unknown;
    try {
      data = await tools.run(name, args);
    } catch (error) {
      log.warn('a tool failed', { tool: name, error: error instanceof Error ? error.message : String(error) });
      return void (await reply(ctx, [[`⚠️ ${toolErrorText(error)}`]]));
    }
    await reply(ctx, draw(data), buttons);
  };

  bot.command('quote', async (ctx) => {
    const [first = '', amount = ''] = argOf(ctx).split(/\s+/);
    const address = detectAddress(first);
    if (!address || !amount) return void (await reply(ctx, [['Send /quote <token address> <amount>, such as /quote <address> 0.5: what a buy for that much gets.']]));
    const token = await source.token(address);
    if (QUOTE_NEEDS_FEED && !token) return void (await reply(ctx, [['The feed has not seen this token, so the coin it trades in is unknown.']]));
    const amountIn = quoteAmountIn(amount, token);
    if (!amountIn) return void (await reply(ctx, [['The amount is a number from 0.001 to 1,000.']]));
    const call = quoteToolCall(address, amountIn.units);
    await ask(ctx, `${address}:${amountIn.units}`, call.name, call.args, (data) => quoteCard(quoteViewOf(data, token), address, links), buttonsFor(links, address));
  });

  bot.command('safety', async (ctx) => {
    const address = detectAddress(argOf(ctx));
    if (!address) return void (await reply(ctx, [['Send /safety <token address>.']]));
    const token = await source.token(address);
    await ask(ctx, address, 'token_safety', { mint: address, ...(token?.creator ? { creator: token.creator } : {}) }, (data) => safetyCard(data as SafetyView, token?.symbol ?? null, address, links), buttonsFor(links, address));
  });

  bot.command('holders', async (ctx) => {
    const address = detectAddress(argOf(ctx));
    if (!address) return void (await reply(ctx, [['Send /holders <token address>.']]));
    const token = await source.token(address);
    await ask(ctx, address, 'holder_map', { mint: address, walk: 10 }, (data) => holdersCard(data as HoldersView, token?.symbol ?? null, address, links), buttonsFor(links, address));
  });

  bot.command('app', async (ctx) => {
    const signature = detectSignature(argOf(ctx));
    if (!signature) return void (await reply(ctx, [['Send /app <transaction signature>, or paste an explorer link to it.']]));
    await ask(ctx, signature, 'identify_trading_app', { signature }, (data) => appCard(data as AppView, links));
  });

  // ---- calls and alerts ----------------------------------------------------

  bot.command('calls', async (ctx) => {
    if (!isGroup(ctx)) return void (await reply(ctx, [['Calls are kept per group: add me to one, and the first card of a token there counts as a call.']]));
    await reply(ctx, await callsCard((await recordOf(ctx))?.calls ?? [], source, links, now()));
  });

  const alertsText = (record: CommunityRecord | null): Line[] => {
    const a = record?.alerts ?? null;
    return [
      [{ bold: 'Alerts in this group' }],
      [`🚀 New launches: ${a?.launches ? `on, past $${fmtShort(a.launches.minMc)}${a.launches.launchpad ? ` on ${launchpadLabel(a.launches.launchpad)}` : ', every launchpad'}` : 'off'}`],
      [`🎓 Graduations: ${a?.graduations ? 'on' : 'off'}`],
      [`🚨 Dev sold: ${record?.buyBot ? `on for the tracked token, ${record.buyBot.symbol ?? shortAddr(record.buyBot.address)}` : 'with the buy bot (/track)'}`],
    ];
  };

  bot.command('launches', async (ctx) => {
    if (!isGroup(ctx)) return void (await reply(ctx, GROUPS_ONLY));
    const record = await recordOf(ctx);
    if (!argOf(ctx)) return void (await reply(ctx, [...alertsText(record), ['Admins: /launches on [market cap] [launchpad], such as /launches on 50k pump.fun, or /launches off.']]));
    if (!(await adminInGroup(ctx))) return;
    const parsed = parseLaunchArgs(argOf(ctx));
    if ('error' in parsed) return void (await reply(ctx, [[parsed.error]]));
    const base = record?.alerts ?? { launches: null, graduations: null };
    await store.upsert(chatKey(ctx), { title: titleOf(ctx), left: false, alerts: { ...base, launches: parsed.on ? { minMc: parsed.minMc, launchpad: parsed.launchpad } : null, setBy: String(ctx.from?.id ?? ''), setAt: now() } });
    changed();
    await reply(ctx, [[parsed.on ? `✅ New launches are posted here the first time they reach $${fmtShort(parsed.minMc)}${parsed.launchpad ? ` on ${launchpadLabel(parsed.launchpad)}` : ''}: tokens younger than an hour, at most one a minute.` : '✅ Launch alerts off.']]);
  });

  bot.command('graduations', async (ctx) => {
    if (!isGroup(ctx)) return void (await reply(ctx, GROUPS_ONLY));
    const record = await recordOf(ctx);
    const mode = argOf(ctx).toLowerCase();
    if (mode !== 'on' && mode !== 'off') return void (await reply(ctx, [...alertsText(record), ['Admins: /graduations on or /graduations off.']]));
    if (!(await adminInGroup(ctx))) return;
    const base = record?.alerts ?? { launches: null, graduations: null };
    await store.upsert(chatKey(ctx), { title: titleOf(ctx), left: false, alerts: { ...base, graduations: mode === 'on' ? { on: true } : null, setBy: String(ctx.from?.id ?? ''), setAt: now() } });
    changed();
    await reply(ctx, [[mode === 'on' ? '✅ Tokens that finish their bonding curve are posted here, at most one a minute.' : '✅ Graduation alerts off.']]);
  });

  bot.command(['help', 'start'], async (ctx) => reply(ctx, help));

  // A pasted address (seen only with privacy mode off, as an admin, or in a private chat). Other text is ignored.
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) return;
    await card(ctx, text, false);
  });

  bot.catch((error) => {
    log.error('update failed', { update: error.ctx.update.update_id, error: error.error instanceof Error ? error.error.message : String(error.error) });
  });

  return { bot, engine, alerts, outbox };
}
