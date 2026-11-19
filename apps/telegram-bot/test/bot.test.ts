/**
 * The bot against a fake Telegram: grammY's API transformer records every
 * call the bot makes and answers it, so no test touches the network.
 */

import { FeedState, MemoryStore, linkTemplates, parseButtons, type ChainTools, type FeedEvent, type FeedTrade } from '@soltoolkit/bot-core';
import { GrammyError } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { createBot } from '../src/bot';
import { readConfig } from '../src/config';
import { Outbox } from '../src/outbox';

const MINT = 'FWFxnxR1Esvv6Ebcntr357ri1mucV5FiKTG1kEiBpump';
const GROUP = -1001234567890;
const ADMIN = 7;
const MEMBER = 8;
const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh';

const botInfo = { id: 1, is_bot: true, first_name: 'Kit', username: 'KitTestBot', can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as UserFromGetMe;

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

function harness(options: { refuse?: (call: Call) => GrammyError | null; poweredBy?: string; cardImage?: boolean; tools?: ChainTools | null } = {}) {
  let now = 1_000_000;
  let updateId = 0;
  const feed = new FeedState({ now: () => now });
  const store = new MemoryStore(() => now);
  const links = linkTemplates({ buttons: parseButtons('Chart|https://example.com/c/{address}') });
  const { bot, engine, alerts, outbox } = createBot({ token: TOKEN, source: feed, store, links, botInfo, now: () => now, sleep: async (ms) => void (now += ms), poweredBy: options.poweredBy ?? null, cardImage: options.cardImage ?? false, tools: options.tools ?? null });
  feed.onTrade(engine.onTrade);
  feed.onToken(alerts.onToken);
  feed.onTrade(alerts.onTrade);
  const calls: Call[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    const call = { method, payload: payload as Record<string, unknown> };
    calls.push(call);
    const refusal = options.refuse?.(call);
    if (refusal) throw refusal;
    if (method === 'getChatMember') return { ok: true, result: { status: call.payload.user_id === ADMIN ? 'administrator' : 'member', user: { id: call.payload.user_id, is_bot: false, first_name: 'U' } } } as never;
    return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: call.payload.chat_id, type: 'supergroup', title: 'G' } } } as never;
  });

  const message = (text: string, from = ADMIN, extra: Record<string, unknown> = {}, chat: Record<string, unknown> = { id: GROUP, type: 'supergroup', title: 'Group' }): Update => {
    const command = /^\/[a-z]+/.exec(text);
    return {
      update_id: ++updateId,
      message: { message_id: updateId, date: 0, chat, from: { id: from, is_bot: false, first_name: 'U' }, text, ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] } : {}), ...extra },
    } as unknown as Update;
  };
  const say = async (text: string, from = ADMIN, extra: Record<string, unknown> = {}, chat?: Record<string, unknown>): Promise<void> => bot.handleUpdate(message(text, from, extra, chat));
  const sent = (): Call[] => calls.filter((c) => c.method.startsWith('send'));
  const lastText = (): string => String(sent().at(-1)?.payload.text ?? sent().at(-1)?.payload.caption ?? '');
  const list = (address: string, symbol = 'ZOP'): void => feed.apply({ type: 'token_upsert', ts: now, token: { address, symbol, name: 'Zop', decimals: 6, stage: 'new', launchpad: 'pumpfun', price: 0.000004, mc: 4_000 } });
  const trade = (over: Partial<FeedTrade> = {}): FeedEvent => ({ type: 'market_trade', ts: now, trade: { address: MINT, tx: 'sig', at: now, side: 'buy', amountToken: '5000000', amountNative: '500000000', usd: 100, price: 0.00002, mc: 20_000, maker: 'Maker1111111111111111111111111111111111111', ...over } });

  return { bot, engine, alerts, outbox, feed, store, calls, say, sent, lastText, list, trade, tick: (ms: number) => (now += ms), message, now: () => now };
}

describe('token cards', () => {
  it('answers /ca with a card and the community\'s buttons', async () => {
    const h = harness();
    h.list(MINT);
    await h.say(`/ca ${MINT}`);
    expect(h.sent()).toHaveLength(1);
    expect(h.lastText()).toContain(`🧪 [Zop](https://solscan.io/token/${MINT})`);
    expect(h.lastText()).toContain(`\`${MINT}\``);
    expect(h.sent()[0]!.payload.parse_mode).toBe('MarkdownV2');
    const keyboard = JSON.stringify(h.sent()[0]!.payload.reply_markup);
    expect(keyboard).toContain(`https://example.com/c/${MINT}`);
    // Copy CA copies the bare address; Refresh calls back with it.
    expect(keyboard).toContain(`"copy_text":{"text":"${MINT}"}`);
    expect(keyboard).toContain(`"callback_data":"r:${MINT}"`);
    expect(h.sent()[0]!.payload.link_preview_options).toEqual({ is_disabled: true });
  });

  it('redraws a card in place on Refresh, at most once in 15 seconds', async () => {
    const h = harness();
    h.list(MINT);
    await h.say(`/ca ${MINT}`);
    const press = async (): Promise<void> =>
      h.bot.handleUpdate({
        update_id: 9_000 + h.calls.length,
        callback_query: { id: 'q', chat_instance: 'c', from: { id: MEMBER, is_bot: false, first_name: 'U' }, data: `r:${MINT}`, message: { message_id: 55, date: 0, chat: { id: GROUP, type: 'supergroup', title: 'G' }, text: 'old' } },
      } as unknown as Update);
    h.feed.apply({ type: 'token_tick', ts: 1, address: MINT, price: 0.00005, mc: 50_000, at: 1 });
    await press();
    const edit = h.calls.find((c) => c.method === 'editMessageText')!;
    expect(edit.payload).toMatchObject({ chat_id: GROUP, message_id: 55, parse_mode: 'MarkdownV2' });
    expect(String(edit.payload.text)).toContain('💎 MC: $50K');
    expect(h.calls.at(-1)).toMatchObject({ method: 'answerCallbackQuery', payload: { text: 'Updated' } });
    await press();
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(1);
    expect(h.calls.at(-1)!.payload.text).toContain('a moment ago');
    h.tick(15_001);
    await press();
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(2);
  });

  it('shows the token picture above a card when the operator turned it on', async () => {
    const h = harness({ cardImage: true });
    h.feed.apply({ type: 'token_upsert', ts: 1, token: { address: MINT, symbol: 'ZOP', name: 'Zop', image: 'https://img.example/zop.png' } });
    await h.say(`/ca ${MINT}`);
    expect(h.sent()[0]!.payload.link_preview_options).toEqual({ url: 'https://img.example/zop.png', prefer_small_media: true, show_above_text: true });
  });

  it('answers a pasted address once in two minutes, and stays quiet about ordinary talk', async () => {
    const h = harness();
    h.list(MINT);
    await h.say(`look at ${MINT}`, MEMBER);
    await h.say(`again ${MINT}`, MEMBER);
    await h.say('gm everyone', MEMBER);
    expect(h.sent()).toHaveLength(1);
    h.tick(120_001);
    await h.say(MINT, MEMBER);
    expect(h.sent()).toHaveLength(2);
  });

  it('says so when asked for a token the feed has not seen, and stays quiet when nobody asked', async () => {
    const h = harness();
    await h.say(MINT, MEMBER);
    expect(h.sent()).toHaveLength(0);
    await h.say(`/ca ${MINT}`);
    expect(h.lastText()).toContain('has not seen');
    await h.say('/ca');
    expect(h.lastText()).toContain('Send /ca');
  });

  it('sends the card as plain text when Telegram refuses the markup', async () => {
    const h = harness({ refuse: (call) => (call.method === 'sendMessage' && call.payload.parse_mode ? new GrammyError('refused', { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, 'sendMessage', {}) : null) });
    h.list(MINT);
    await h.say(`/ca ${MINT}`);
    expect(h.sent()).toHaveLength(2);
    expect(h.sent()[1]!.payload.parse_mode).toBeUndefined();
    expect(h.lastText()).toContain(`🧪 Zop (https://solscan.io/token/${MINT})`);
  });

  it('lists the most traded tokens', async () => {
    const h = harness();
    await h.say('/trending');
    expect(h.lastText()).toContain('Nothing with a dollar volume');
    h.list(MINT);
    h.feed.apply(h.trade());
    await h.say('/trending');
    expect(h.lastText()).toContain('top 1 by 5m volume');
    expect(h.lastText()).toContain('[ZOP]');
  });
});

describe('the buy bot', () => {
  it('lets only an admin turn it on, by Telegram\'s own word', async () => {
    const h = harness();
    await h.say(`/track ${MINT}`, MEMBER);
    expect(h.lastText()).toContain('Only a group admin');
    expect(await h.store.get(String(GROUP))).toBeNull();
    await h.say(`/track ${MINT}`, ADMIN);
    expect(h.lastText()).toContain('Buy bot on for FWFx…pump');
    expect(h.lastText()).toContain('No trade of this token seen yet');
    expect((await h.store.get(String(GROUP)))!.buyBot).toMatchObject({ address: MINT, minUsd: 25, symbol: null, setBy: '7' });
  });

  it('refuses the admin commands in a private chat', async () => {
    const h = harness();
    await h.say(`/track ${MINT}`, ADMIN, {}, { id: ADMIN, type: 'private', first_name: 'U' });
    expect(h.lastText()).toContain('works in a group');
    expect(h.calls.some((c) => c.method === 'getChatMember')).toBe(false);
  });

  it('posts a buy, merges a busy spell, and keeps to one post every ten seconds', async () => {
    const h = harness();
    h.list(MINT);
    await h.say(`/track ${MINT}`);
    expect(h.lastText()).toContain('Buy bot on for ZOP');
    const before = h.sent().length;
    await h.engine.flush();
    h.feed.apply(h.trade());
    await h.engine.flush();
    expect(h.sent()).toHaveLength(before + 1);
    expect(h.lastText()).toContain('*ZOP buy*');
    expect(h.lastText()).toContain('$100\\.00 \\(0\\.5 SOL\\)');
    h.feed.apply(h.trade({ tx: 'b', usd: 400 }));
    h.feed.apply(h.trade({ tx: 'c', usd: 50 }));
    await h.engine.flush();
    expect(h.sent()).toHaveLength(before + 1);
    h.tick(10_000);
    await h.engine.flush();
    expect(h.sent()).toHaveLength(before + 2);
    expect(h.lastText()).toContain('*ZOP: 2 buys* · $450\\.00');
  });

  it('changes the minimum, shows the settings, and stops', async () => {
    const h = harness();
    await h.say('/minbuy 100');
    expect(h.lastText()).toContain('No token is tracked here');
    await h.say(`/track ${MINT}`);
    await h.say('/minbuy 250', MEMBER);
    expect(h.lastText()).toContain('Only a group admin');
    await h.say('/minbuy 0');
    expect(h.lastText()).toContain('from 1 to 1,000,000');
    await h.say('/minbuy $2.5k');
    expect(h.lastText()).toContain('$2,500\\.00 or more');
    await h.say('/minbuy', MEMBER);
    expect(h.lastText()).toContain('$2,500\\.00 or more are posted\\. Admins');
    await h.say('/buybot', MEMBER);
    expect(h.lastText()).toContain('Least buy posted: $2,500\\.00 · Picture: none');
    h.feed.apply(h.trade({ usd: 2_499 }));
    await h.engine.flush();
    expect(h.lastText()).toContain('Least buy posted');
    await h.say('/untrack');
    expect((await h.store.get(String(GROUP)))!.buyBot).toBeNull();
  });

  it('posts with a picture, and as text when the group refuses media', async () => {
    const h = harness({ refuse: (call) => (call.method === 'sendPhoto' && call.payload.chat_id === String(GROUP) && call.payload.photo === 'refused' ? new GrammyError('refused', { ok: false, error_code: 400, description: 'Bad Request: not enough rights to send photos to the chat' }, 'sendPhoto', {}) : null) });
    await h.say(`/track ${MINT}`);
    await h.say('/buymedia');
    expect(h.lastText()).toContain('Reply to a picture');
    await h.say('/buymedia', ADMIN, { reply_to_message: { message_id: 1, date: 0, chat: { id: GROUP, type: 'supergroup', title: 'Group' }, photo: [{ file_id: 'small', file_unique_id: 'a', width: 1, height: 1 }, { file_id: 'big', file_unique_id: 'b', width: 9, height: 9 }] } });
    expect((await h.store.get(String(GROUP)))!.buyBot!.media).toEqual({ kind: 'photo', fileId: 'big' });
    await h.engine.flush();
    h.feed.apply(h.trade());
    await h.engine.flush();
    expect(h.sent().at(-1)!.method).toBe('sendPhoto');
    expect(h.sent().at(-1)!.payload.photo).toBe('big');

    await h.store.upsert(String(GROUP), { buyBot: { ...(await h.store.get(String(GROUP)))!.buyBot!, media: { kind: 'photo', fileId: 'refused' } } });
    h.engine.invalidate();
    h.tick(10_000);
    await h.engine.flush();
    h.feed.apply(h.trade({ tx: 'second' }));
    await h.engine.flush();
    expect(h.sent().at(-1)!.method).toBe('sendMessage');
    await h.say('/buymedia off');
    expect((await h.store.get(String(GROUP)))!.buyBot!.media).toBeNull();
  });

  it('stops posting to a group that removed it, and follows a group to its new id', async () => {
    const h = harness({ refuse: (call) => (call.method === 'sendMessage' && call.payload.chat_id === String(GROUP) && String(call.payload.text).includes('buy*') ? new GrammyError('gone', { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' }, 'sendMessage', {}) : null) });
    await h.say(`/track ${MINT}`);
    await h.engine.flush();
    h.feed.apply(h.trade());
    await h.engine.flush();
    expect((await h.store.get(String(GROUP)))!.left).toBe(true);

    const moved = harness();
    await moved.say(`/track ${MINT}`);
    await moved.bot.handleUpdate({ update_id: 99, message: { message_id: 99, date: 0, chat: { id: GROUP, type: 'group', title: 'Group' }, from: { id: ADMIN, is_bot: false, first_name: 'U' }, migrate_to_chat_id: -100999 } } as unknown as Update);
    expect((await moved.store.get('-100999'))!.buyBot).toMatchObject({ address: MINT });
    expect((await moved.store.get(String(GROUP)))!.buyBot).toBeNull();
  });

  it('greets a group it was added to and notes when it is removed', async () => {
    const h = harness();
    const member = (was: string, is: string): Update => ({ update_id: 500, my_chat_member: { chat: { id: GROUP, type: 'supergroup', title: 'Group' }, from: { id: ADMIN, is_bot: false, first_name: 'U' }, date: 0, old_chat_member: { status: was, user: botInfo }, new_chat_member: { status: is, user: botInfo } } }) as unknown as Update;
    await h.bot.handleUpdate(member('left', 'member'));
    expect(h.lastText()).toContain('What this bot does');
    expect(await h.store.get(String(GROUP))).toMatchObject({ title: 'Group', left: false });
    await h.bot.handleUpdate(member('member', 'kicked'));
    expect((await h.store.get(String(GROUP)))!.left).toBe(true);
  });

  it('ends the welcome and /help with the operator credit line when one is set', async () => {
    const plain = harness();
    await plain.say('/help');
    expect(plain.lastText()).not.toContain('Powered by');
    const credited = harness({ poweredBy: 'Powered by Example · example.com' });
    await credited.say('/help');
    expect(credited.lastText()).toContain('Powered by Example');
  });
});

describe('the outbox', () => {
  it('drops a message that would wait too long, and waits out a 429 once', async () => {
    let now = 0;
    let refused = false;
    const api = {
      sendMessage: async () => {
        if (!refused) {
          refused = true;
          throw new GrammyError('slow down', { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 2 } }, 'sendMessage', {});
        }
        return { message_id: 5 };
      },
    };
    const outbox = new Outbox(api as never, { now: () => now, sleep: async (ms) => void (now += ms), limits: { groupPerMinute: 3 } });
    // The refused attempt used a slot too: two of the minute's three are taken.
    expect(await outbox.text('-1', [['a']], { kind: 'buy', maxWaitMs: 5_000 })).toEqual({ outcome: 'sent', messageId: 5 });
    expect(now).toBe(2_000);
    expect((await outbox.text('-1', [['b']], { kind: 'buy' })).outcome).toBe('sent');
    expect((await outbox.text('-1', [['c']], { kind: 'buy' })).outcome).toBe('dropped');
    expect(outbox.getStats().buy).toEqual({ sent: 2, dropped: 1, gone: 0, failed: 0, limited: 1 });
  });
});

describe("the chain's tools", () => {
  const SIGNATURE = '4YSbm9KCpDV2orrQPeXg41hw9tzdSfNLe3ehJzqkPNxoTgepXwKWZhcjSbtkwFqzNKKCxNNnpL9XFKsDQt3u3gVc';
  const fake = (): ChainTools & { asked: { name: string; args: Record<string, unknown> }[] } => {
    const asked: { name: string; args: Record<string, unknown> }[] = [];
    return {
      asked,
      tools: ['launchpad_quote', 'token_safety', 'holder_map', 'identify_trading_app'],
      async run(name, args) {
        asked.push({ name, args });
        if (name === 'launchpad_quote') return { venue: 'pumpfun', side: 'buy', inAmount: args.amountIn, outAmount: '12000000000000', minOutAmount: '11640000000000', slippageBps: 300, venueFeeLamports: '5000000', priceImpactBps: 120 };
        if (name === 'identify_trading_app') return { signature: args.signature, failed: false, platform: 'Axiom', by: 'fee-wallet', evidence: 'Fee1111111111111111111111111111111111' };
        throw Object.assign(new Error('That address is not a token mint.'), { code: 'NOT_A_TOKEN' });
      },
    };
  };

  it('says so when the bot runs without a chain endpoint', async () => {
    const h = harness();
    await h.say(`/quote ${MINT} 0.5`);
    expect(h.lastText()).toContain('without a chain endpoint');
  });

  it('quotes a buy in SOL, once in 30 seconds per chat, with the community\'s buttons', async () => {
    const tools = fake();
    const h = harness({ tools });
    h.list(MINT);
    await h.say(`/quote ${MINT} 0.5`, MEMBER);
    expect(tools.asked[0]).toEqual({ name: 'launchpad_quote', args: { mint: MINT, side: 'buy', amountIn: '500000000' } });
    expect(h.lastText()).toContain('💱 *Quote: 0\\.5 SOL → ZOP* · on pump\\.fun');
    expect(h.lastText()).toContain('🪙 You get: 12M ZOP');
    expect(JSON.stringify(h.sent().at(-1)!.payload.reply_markup)).toContain(`https://example.com/c/${MINT}`);
    await h.say(`/quote ${MINT} 0.5`, MEMBER);
    expect(h.lastText()).toContain('Asked a moment ago');
    await h.say(`/quote ${MINT} lots`, MEMBER);
    expect(h.lastText()).toContain('from 0\\.001 to 1,000');
    await h.say('/quote', MEMBER);
    expect(h.lastText()).toContain('Send /quote');
  });

  it('says a tool\'s own failure as the tool said it, and names the app behind a trade', async () => {
    const h = harness({ tools: fake() });
    await h.say(`/safety ${MINT}`, MEMBER);
    expect(h.lastText()).toContain('⚠️ That address is not a token mint\\.');
    await h.say(`/app https://solscan.io/tx/${SIGNATURE}`, MEMBER);
    expect(h.lastText()).toContain('🔎 *Placed with Axiom*');
    await h.say('/app nothing', MEMBER);
    expect(h.lastText()).toContain('Send /app');
  });
});

describe('calls and alerts', () => {
  it('credits the first caller of a token in a group, and ranks the week\'s calls', async () => {
    const h = harness();
    h.list(MINT);
    await h.say(`/ca ${MINT}`, ADMIN, { from: { id: ADMIN, is_bot: false, first_name: 'Ana', username: 'ana_calls' } });
    expect(h.lastText()).toContain('🏆 First call: ana\\_calls @ 4K');
    h.feed.apply({ type: 'token_tick', ts: 1, address: MINT, price: 0.00002, mc: 20_000, at: 1 });
    h.tick(3_600_000);
    await h.say(`/ca ${MINT}`, MEMBER);
    expect(h.lastText()).toContain('🏆 ana\\_calls @ 4K · 5\\.0x · 1h');
    await h.say('/calls', MEMBER);
    expect(h.lastText()).toContain('🥇 [ZOP]');
    expect(h.lastText()).toContain('5\\.0x');
    // A private chat keeps no calls.
    await h.say(`/ca ${MINT}`, MEMBER, {}, { id: MEMBER, type: 'private', first_name: 'U' });
    expect(h.lastText()).not.toContain('🏆');
  });

  it('lets only admins switch alerts, and posts a graduation in the group', async () => {
    const h = harness();
    await h.say('/launches on 50k pump.fun', MEMBER);
    expect(h.lastText()).toContain('Only a group admin');
    await h.say('/launches on 50k nowhere');
    expect(h.lastText()).toContain('not a launchpad');
    await h.say('/launches on 50k pump.fun');
    expect(h.lastText()).toContain('reach $50K on pump\\.fun');
    await h.say('/graduations on');
    const record = await h.store.get(String(GROUP));
    expect(record!.alerts).toMatchObject({ launches: { minMc: 50_000, launchpad: 'pumpfun' }, graduations: { on: true } });
    await h.say('/launches', MEMBER);
    expect(h.lastText()).toContain('🎓 Graduations: on');

    // The engine reads the new settings on its next round (every two seconds when running).
    await h.alerts.refresh();
    h.feed.apply({ type: 'token_upsert', ts: 1, token: { address: MINT, symbol: 'ZOP', name: 'Zop', launchpad: 'pumpfun', stage: 'bonding', mc: 60_000, createdAt: h.now() } });
    h.feed.apply({ type: 'token_patch', ts: 1, address: MINT, patch: { stage: 'migrated' } });
    // One alert per group per round.
    await h.alerts.flush();
    await h.alerts.flush();
    const posts = h.sent().filter((c) => String(c.payload.text).startsWith('🚀') || String(c.payload.text).startsWith('🎓'));
    expect(posts.map((c) => String(c.payload.text).split('\n')[0])).toEqual(['🚀 *New launch past $50K* on pump\\.fun', '🎓 *Graduated from pump\\.fun*']);
    await h.say('/graduations off');
    expect((await h.store.get(String(GROUP)))!.alerts!.graduations).toBeNull();
  });
});

describe('settings', () => {
  it('reads a complete configuration', () => {
    const config = readConfig({ TELEGRAM_BOT_TOKEN: TOKEN, REDIS_URL: 'redis://localhost:6379', BOT_BUTTONS: 'Chart|https://example.com/{address}', LINK_TX: 'https://example.com/tx/{tx}' });
    expect(config.feed).toEqual({ kind: 'redis', url: 'redis://localhost:6379', key: 'stream:market:solana' });
    expect(config.links.buttons).toEqual([{ label: 'Chart', url: 'https://example.com/{address}' }]);
    expect(config.links.tx).toBe('https://example.com/tx/{tx}');
    expect(config.storePath).toBe('./data/telegram.json');
    expect(config.snapshotPath).toBe('./data/feed-snapshot.json');
    expect(readConfig({ TELEGRAM_BOT_TOKEN: TOKEN, SNAPSHOT_PATH: 'off' }).snapshotPath).toBeNull();
    expect(config.poweredBy).toBeNull();
    expect(readConfig({ TELEGRAM_BOT_TOKEN: TOKEN }).feed).toEqual({ kind: 'stdin' });
    expect(readConfig({ TELEGRAM_BOT_TOKEN: TOKEN, BOT_POWERED_BY: 'Powered by Example' }).poweredBy).toBe('Powered by Example');
    expect(() => readConfig({ TELEGRAM_BOT_TOKEN: TOKEN, BOT_POWERED_BY: 'x'.repeat(121) })).toThrow(/120 characters/);
  });

  it('stops at start on a setting that is missing or malformed', () => {
    expect(() => readConfig({})).toThrow(/TELEGRAM_BOT_TOKEN is required/);
    expect(() => readConfig({ TELEGRAM_BOT_TOKEN: 'nope' })).toThrow(/does not look like/);
    expect(() => readConfig({ TELEGRAM_BOT_TOKEN: TOKEN, FEED: 'redis' })).toThrow(/REDIS_URL is required/);
    expect(() => readConfig({ TELEGRAM_BOT_TOKEN: TOKEN, FEED: 'kafka' })).toThrow(/stdin or redis/);
    expect(() => readConfig({ TELEGRAM_BOT_TOKEN: TOKEN, REDIS_URL: 'http://x' })).toThrow(/redis:\/\//);
    expect(() => readConfig({ TELEGRAM_BOT_TOKEN: TOKEN, BOT_BUTTONS: 'Chart|http://example.com' })).toThrow(/https/);
  });
});
