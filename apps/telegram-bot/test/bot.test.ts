/**
 * The bot against a fake Telegram: grammY's API transformer records every
 * call the bot makes and answers it, so no test touches the network.
 */

import { FeedState, MemoryStore, linkTemplates, parseButtons, type FeedEvent, type FeedTrade } from '@soltoolkit/bot-core';
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

function harness(options: { refuse?: (call: Call) => GrammyError | null } = {}) {
  let now = 1_000_000;
  let updateId = 0;
  const feed = new FeedState({ now: () => now });
  const store = new MemoryStore(() => now);
  const links = linkTemplates({ buttons: parseButtons('Chart|https://example.com/c/{address}') });
  const { bot, engine, outbox } = createBot({ token: TOKEN, source: feed, store, links, botInfo, now: () => now, sleep: async (ms) => void (now += ms) });
  feed.onTrade(engine.onTrade);
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

  return { bot, engine, outbox, feed, store, calls, say, sent, lastText, list, trade, tick: (ms: number) => (now += ms), message };
}

describe('token cards', () => {
  it('answers /ca with a card and the community\'s buttons', async () => {
    const h = harness();
    h.list(MINT);
    await h.say(`/ca ${MINT}`);
    expect(h.sent()).toHaveLength(1);
    expect(h.lastText()).toContain('*ZOP* — Zop');
    expect(h.lastText()).toContain(`\`${MINT}\``);
    expect(h.sent()[0]!.payload.parse_mode).toBe('MarkdownV2');
    expect(JSON.stringify(h.sent()[0]!.payload.reply_markup)).toContain(`https://example.com/c/${MINT}`);
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
    expect(h.lastText()).toContain('ZOP — Zop');
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

describe('settings', () => {
  it('reads a complete configuration', () => {
    const config = readConfig({ TELEGRAM_BOT_TOKEN: TOKEN, REDIS_URL: 'redis://localhost:6379', BOT_BUTTONS: 'Chart|https://example.com/{address}', LINK_TX: 'https://example.com/tx/{tx}' });
    expect(config.feed).toEqual({ kind: 'redis', url: 'redis://localhost:6379', key: 'stream:market:solana' });
    expect(config.links.buttons).toEqual([{ label: 'Chart', url: 'https://example.com/{address}' }]);
    expect(config.links.tx).toBe('https://example.com/tx/{tx}');
    expect(config.storePath).toBe('./data/telegram.json');
    expect(readConfig({ TELEGRAM_BOT_TOKEN: TOKEN }).feed).toEqual({ kind: 'stdin' });
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
