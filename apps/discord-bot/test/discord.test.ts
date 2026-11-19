/** The slash commands and the embeds, without a Discord client: commands are plain functions of what was asked. */

import { FeedState, MemoryStore, buyOf, linkTemplates, parseButtons, type FeedTrade } from '@soltoolkit/bot-core';
import { describe, expect, it } from 'vitest';
import { COLORS, buyPayload, tokenPayload } from '../src/cards';
import { COMMANDS, handleButton, handleCommand, newRefreshGate, type CommandInput } from '../src/commands';
import { readConfig } from '../src/config';

const MINT = 'FWFxnxR1Esvv6Ebcntr357ri1mucV5FiKTG1kEiBpump';
const GUILD = '123456789012345678';

function harness() {
  let now = 1_000_000;
  let changes = 0;
  const feed = new FeedState({ now: () => now });
  const store = new MemoryStore(() => now);
  const links = linkTemplates({ buttons: parseButtons('Chart|https://example.com/c/{address}') });
  const deps = { source: feed, store, links, changed: () => void (changes += 1), now: () => now };
  const run = (name: string, over: Partial<CommandInput> = {}) => handleCommand({ name, guildId: GUILD, guildName: 'Server', channelId: '111', userId: '7', canManage: true, ...over }, deps);
  const text = (reply: Awaited<ReturnType<typeof run>>): string => reply.payload.embeds?.[0]?.description ?? '';
  const list = (symbol = 'ZOP', name = 'Zop'): void => feed.apply({ type: 'token_upsert', ts: now, token: { address: MINT, symbol, name, decimals: 6, stage: 'new', launchpad: 'pumpfun', price: 0.000004, mc: 4_000 } });
  const trade = (over: Partial<FeedTrade> = {}): FeedTrade => ({ address: MINT, tx: 'sig', at: now, side: 'buy', amountToken: '5000000', amountNative: '500000000', usd: 100, price: 0.00002, mc: 20_000, maker: 'Maker1111111111111111111111111111111111111', ...over });
  return { feed, store, links, run, text, list, trade, changes: () => changes, tick: (ms: number) => (now += ms), now: () => now };
}

describe('commands', () => {
  it('registers every command for servers only, the admin ones for managers', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(['ca', 'trending', 'track', 'minbuy', 'untrack', 'buybot', 'help']);
    expect(COMMANDS.every((c) => c.dm_permission === false)).toBe(true);
    expect(COMMANDS.filter((c) => c.default_member_permissions).map((c) => c.name)).toEqual(['track', 'minbuy', 'untrack']);
    for (const command of COMMANDS) expect(command.description.length).toBeLessThanOrEqual(100);
  });

  it('ends /help with the operator credit line when one is set', async () => {
    const h = harness();
    expect(h.text(await h.run('help'))).not.toContain('Powered by');
    const store = new MemoryStore(() => 0);
    const credited = await handleCommand(
      { name: 'help', guildId: GUILD, guildName: 'Server', channelId: '111', userId: '7', canManage: true },
      { source: new FeedState(), store, links: h.links, changed: () => undefined, poweredBy: 'Powered by Example · example.com' },
    );
    expect(credited.payload.embeds?.[0]?.description ?? '').toContain('Powered by Example');
  });

  it('answers /ca with a card and the community\'s buttons, for everyone to see', async () => {
    const h = harness();
    h.list();
    const reply = await h.run('ca', { address: MINT, canManage: false });
    expect(reply.ephemeral).toBe(false);
    expect(h.text(reply)).toContain(`🧪 [Zop](<https://solscan.io/token/${MINT}>)`);
    expect(h.text(reply)).toContain('💎 MC: `$4K`');
    expect(reply.payload.components?.[0]?.components[0]).toMatchObject({ label: 'Chart', url: `https://example.com/c/${MINT}` });
    expect(reply.payload.components?.[1]?.components.map((b) => ('custom_id' in b ? b.custom_id : null))).toEqual([`c:${MINT}`, `r:${MINT}`]);
    expect(reply.payload.allowedMentions).toEqual({ parse: [] });
  });

  it('answers Copy CA with the bare address, and redraws the card on Refresh at most once in 15 seconds', async () => {
    const h = harness();
    h.list();
    const gate = newRefreshGate(() => h.now());
    const deps = { source: h.feed, store: h.store, links: h.links, changed: () => undefined, now: () => h.now(), gate, poweredBy: 'Powered by Example' };
    const copy = await handleButton({ customId: `c:${MINT}`, messageId: '1' }, deps);
    expect(copy).toEqual({ kind: 'reply', payload: { content: MINT, allowedMentions: { parse: [] } } });
    h.feed.apply({ type: 'token_tick', ts: 1, address: MINT, price: 0.00005, mc: 50_000, at: 1 });
    const fresh = await handleButton({ customId: `r:${MINT}`, messageId: '1' }, deps);
    expect(fresh?.kind).toBe('update');
    expect(fresh!.payload.embeds![0]!.description).toContain('💎 MC: `$50K`');
    expect(fresh!.payload.embeds![0]!.footer).toEqual({ text: 'Powered by Example' });
    expect((await handleButton({ customId: `r:${MINT}`, messageId: '1' }, deps))!.payload.embeds![0]!.description).toContain('a moment ago');
    h.tick(15_001);
    expect((await handleButton({ customId: `r:${MINT}`, messageId: '1' }, deps))?.kind).toBe('update');
    expect(await handleButton({ customId: 'other', messageId: '1' }, deps)).toBeNull();
    expect(await handleButton({ customId: 'r:not-an-address', messageId: '1' }, deps)).toBeNull();
  });

  it('colours a card by the price move and shows the token picture', () => {
    const h = harness();
    const base = { address: MINT, symbol: 'ZOP', name: 'Zop', m5: { trades: 2, buys: 1, volumeUsd: 10, priceChangePct: 5 }, lastTradeAt: null };
    expect(tokenPayload(base, h.links, 0).embeds![0]!.color).toBe(COLORS.up);
    expect(tokenPayload({ ...base, h1: { buys: 1, sells: 1, volumeUsd: 1, priceChangePct: -3 } }, h.links, 0).embeds![0]!.color).toBe(COLORS.down);
    expect(tokenPayload({ ...base, m5: { ...base.m5, priceChangePct: null } }, h.links, 0).embeds![0]!.color).toBe(COLORS.card);
    expect(tokenPayload({ ...base, image: 'https://img.example/a.png' }, h.links, 0).embeds![0]!.thumbnail).toEqual({ url: 'https://img.example/a.png' });
    expect(tokenPayload({ ...base, image: 'http://img.example/a.png' }, h.links, 0).embeds![0]!.thumbnail).toBeUndefined();
  });

  it('tells only the asker when the address is wrong or the feed has not seen the token', async () => {
    const h = harness();
    const unseen = await h.run('ca', { address: MINT });
    expect(unseen.ephemeral).toBe(true);
    expect(h.text(unseen)).toContain('has not seen');
    expect(h.text(await h.run('ca', { address: 'hello' }))).toContain('not a Solana token address');
    expect(h.text(await h.run('ca', { address: MINT, guildId: null }))).toContain('works in a server');
  });

  it('lists the most traded tokens', async () => {
    const h = harness();
    expect(h.text(await h.run('trending'))).toContain('Nothing with a dollar volume');
    h.list();
    h.feed.apply({ type: 'market_trade', ts: 1, trade: h.trade() });
    expect(h.text(await h.run('trending'))).toContain('top 1 by 5m volume');
  });

  it('lets only a manager set the buy bot up, in the channel asked for', async () => {
    const h = harness();
    const refused = await h.run('track', { address: MINT, canManage: false });
    expect(refused.ephemeral).toBe(true);
    expect(h.text(refused)).toContain('manage the server');
    expect(await h.store.get(GUILD)).toBeNull();

    h.list();
    const on = await h.run('track', { address: MINT, channel: '222' });
    expect(h.text(on)).toContain('Buy bot on for ZOP');
    expect(h.text(on)).toContain(`https://discord.com/channels/${GUILD}/222`);
    expect(h.text(on)).toContain('No trade of this token seen yet');
    expect((await h.store.get(GUILD))!.buyBot).toMatchObject({ address: MINT, symbol: 'ZOP', decimals: 6, minUsd: 25, channelId: '222', setBy: '7' });
    expect(h.changes()).toBe(1);

    h.feed.apply({ type: 'market_trade', ts: 1, trade: h.trade() });
    h.tick(45_000);
    expect(h.text(await h.run('buybot', { canManage: false }))).toContain('last 45s ago');
  });

  it('keeps the minimum and the channel sensible', async () => {
    const h = harness();
    expect(h.text(await h.run('minbuy', { usd: 100 }))).toContain('No token is tracked here');
    await h.run('track', { address: MINT });
    expect((await h.store.get(GUILD))!.buyBot!.channelId).toBe('111');
    expect(h.text(await h.run('minbuy', { usd: 0.5 }))).toContain('from 1 to 1,000,000');
    expect(h.text(await h.run('minbuy', { usd: 250, canManage: false }))).toContain('manage the server');
    expect(h.text(await h.run('minbuy', { usd: 250.456 }))).toContain('$250.46 or more');
    // Tracking another token keeps the minimum the server chose.
    await h.run('track', { address: 'So11111111111111111111111111111111111111112' });
    expect((await h.store.get(GUILD))!.buyBot).toMatchObject({ minUsd: 250.46, symbol: null, decimals: null });
    await h.run('untrack');
    expect((await h.store.get(GUILD))!.buyBot).toBeNull();
    expect(h.text(await h.run('buybot'))).toContain('No token is tracked here');
    expect(h.text(await h.run('nope'))).toContain('Unknown command');
  });
});

describe('embeds', () => {
  it('pings nobody, whatever a token is called', async () => {
    const h = harness();
    h.list('@everyone', '[click](https://evil.example) <@&1>');
    const payload = tokenPayload((await h.feed.token(MINT))!, h.links, 1_000_000);
    const text = payload.embeds![0]!.description!;
    expect(text).not.toContain('@everyone');
    expect(text).toContain('@​everyone');
    expect(text).toContain('\\[click\\]\\(https://evil.example\\)');
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('colours a whale buy apart and merges several buys into one embed', () => {
    const h = harness();
    const config = { address: MINT, symbol: 'ZOP', decimals: 6, minUsd: 25, channelId: '1', setBy: null, setAt: 0 };
    const one = buyPayload({ config, buys: [buyOf(h.trade())!], windowMs: 1_000 }, h.links);
    expect(one.embeds![0]!.color).toBe(COLORS.buy);
    expect(one.embeds![0]!.description).toContain('**ZOP buy**');
    expect(one.embeds![0]!.description).toContain('[tx](<https://solscan.io/tx/sig>)');
    expect(buyPayload({ config, buys: [buyOf(h.trade({ usd: 5_000 }))!], windowMs: 1_000 }, h.links).embeds![0]!.color).toBe(COLORS.whale);
    const merged = buyPayload({ config, buys: [buyOf(h.trade())!, buyOf(h.trade({ usd: 5_000 }))!], windowMs: 10_000 }, h.links);
    expect(merged.embeds![0]!.color).toBe(COLORS.buy);
    expect(merged.embeds![0]!.description).toContain('**ZOP: 2 buys** · $5,100.00 in 10 s');
  });
});

describe('settings', () => {
  const base = { DISCORD_BOT_TOKEN: 'a-token', DISCORD_APPLICATION_ID: '123456789012345678' };

  it('reads a complete configuration', () => {
    const config = readConfig({ ...base, REDIS_URL: 'rediss://cache:6380', DISCORD_MESSAGE_CONTENT: '1' });
    expect(config.feed).toEqual({ kind: 'redis', url: 'rediss://cache:6380', key: 'stream:market:solana' });
    expect(config.messageContent).toBe(true);
    expect(config.storePath).toBe('./data/discord.json');
    expect(readConfig(base)).toMatchObject({ feed: { kind: 'stdin' }, messageContent: false, poweredBy: null });
    expect(readConfig({ ...base, BOT_POWERED_BY: 'Powered by Example' }).poweredBy).toBe('Powered by Example');
    expect(() => readConfig({ ...base, BOT_POWERED_BY: 'x'.repeat(121) })).toThrow(/120 characters/);
  });

  it('stops at start on a setting that is missing or malformed', () => {
    expect(() => readConfig({})).toThrow(/DISCORD_BOT_TOKEN is required/);
    expect(() => readConfig({ DISCORD_BOT_TOKEN: 'x' })).toThrow(/DISCORD_APPLICATION_ID is required/);
    expect(() => readConfig({ DISCORD_BOT_TOKEN: 'x', DISCORD_APPLICATION_ID: 'abc' })).toThrow(/15 to 22 digits/);
    expect(() => readConfig({ ...base, FEED: 'redis' })).toThrow(/REDIS_URL is required/);
    expect(() => readConfig({ ...base, DISCORD_MESSAGE_CONTENT: 'yes' })).toThrow(/1 or 0/);
  });
});
