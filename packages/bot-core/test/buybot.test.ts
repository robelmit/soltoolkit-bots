import { describe, expect, it } from 'vitest';
import { BuyBotEngine, MemoryStore, buyOf, buyPostCard, isWhale, linkTemplates, sizeBar, toPlain, withTokenFacts, type BuyBotConfig, type BuyPost, type CommunityRecord, type FeedTrade, type PostOutcome } from '../src';

const MINT = 'So1anaMint1111111111111111111111111111111111';
const config = (over: Partial<BuyBotConfig> = {}): BuyBotConfig => ({ address: MINT, symbol: 'TOK', decimals: 6, minUsd: 25, setBy: 'admin', setAt: 0, ...over });
const trade = (over: Partial<FeedTrade> = {}): FeedTrade => ({ address: MINT, tx: 'sig', at: 100_000, side: 'buy', amountToken: '5000000', amountNative: '500000000', usd: 100, price: 0.00002, mc: 20_000, maker: 'Maker1111111111111111111111111111111111111', ...over });

async function setup(options: { outcome?: PostOutcome | (() => PostOutcome) } = {}) {
  let now = 100_000;
  const store = new MemoryStore(() => now);
  const posts: { id: string; post: BuyPost }[] = [];
  const engine = new BuyBotEngine({
    store,
    now: () => now,
    post: async (community: CommunityRecord, post: BuyPost) => {
      posts.push({ id: community.id, post });
      const outcome = options.outcome ?? 'sent';
      return typeof outcome === 'function' ? outcome() : outcome;
    },
  });
  await store.upsert('g1', { title: 'One', buyBot: config() });
  await engine.refresh();
  return { engine, store, posts, at: (t: number) => (now = t), tick: (ms: number) => (now += ms) };
}

describe('buyOf', () => {
  it('takes buys with a dollar value on the token\'s own market, and nothing else', () => {
    expect(buyOf(trade())).toMatchObject({ usd: 100 });
    expect(buyOf(trade({ side: 'sell' }))).toBeNull();
    expect(buyOf(trade({ usd: null }))).toBeNull();
    expect(buyOf(trade({ usd: 0 }))).toBeNull();
    expect(buyOf(trade({ offMarket: true }))).toBeNull();
  });
});

describe('BuyBotEngine', () => {
  it('posts one buy as itself', async () => {
    const { engine, posts } = await setup();
    engine.onTrade(trade());
    await engine.flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.post.buys).toHaveLength(1);
    expect(engine.getStats()).toMatchObject({ trades: 1, matched: 1, posts: 1, merged: 0, communities: 1 });
  });

  it('leaves out buys under the minimum, sells, other tokens and old buys', async () => {
    const { engine, posts } = await setup();
    engine.onTrade(trade({ usd: 24.99 }));
    engine.onTrade(trade({ side: 'sell' }));
    engine.onTrade(trade({ address: 'Other' }));
    engine.onTrade(trade({ at: 100_000 - 60_001 }));
    await engine.flush();
    expect(posts).toHaveLength(0);
    expect(engine.getStats().matched).toBe(0);
  });

  it('merges the buys of a busy spell into one post, at most one post every ten seconds', async () => {
    const { engine, posts, tick } = await setup();
    engine.onTrade(trade({ tx: 'a' }));
    await engine.flush();
    tick(3_000);
    engine.onTrade(trade({ tx: 'b', at: 103_000, usd: 400 }));
    engine.onTrade(trade({ tx: 'c', at: 103_000, usd: 50 }));
    await engine.flush();
    expect(posts).toHaveLength(1);
    tick(7_000);
    engine.onTrade(trade({ tx: 'd', at: 110_000, usd: 30 }));
    await engine.flush();
    expect(posts).toHaveLength(2);
    expect(posts[1]!.post.buys.map((b) => b.tx)).toEqual(['b', 'c', 'd']);
    expect(posts[1]!.post.windowMs).toBe(7_000);
    expect(engine.getStats()).toMatchObject({ posts: 2, merged: 1 });
  });

  it('posts to every community that follows the token, each by its own minimum', async () => {
    const { engine, store, posts } = await setup();
    await store.upsert('g2', { buyBot: config({ minUsd: 500 }) });
    engine.invalidate();
    await engine.refresh();
    engine.onTrade(trade({ usd: 100 }));
    engine.onTrade(trade({ usd: 600, tx: 'big' }));
    await engine.flush();
    const byId = Object.fromEntries(posts.map((p) => [p.id, p.post.buys.map((b) => b.usd)]));
    expect(byId).toEqual({ g1: [100, 600], g2: [600] });
  });

  it('keeps the biggest buys of a storm', async () => {
    const { engine, posts } = await setup();
    for (let i = 0; i < 201; i += 1) engine.onTrade(trade({ tx: `t${i}`, usd: 25 + i }));
    await engine.flush();
    const buys = posts[0]!.post.buys;
    expect(buys).toHaveLength(50);
    expect(Math.min(...buys.map((b) => b.usd))).toBe(176);
  });

  it('stops posting to a community that turned the buy bot off or changed its token', async () => {
    const { engine, store, posts } = await setup();
    engine.onTrade(trade());
    await store.upsert('g1', { buyBot: null });
    engine.invalidate();
    await engine.flush();
    expect(posts).toHaveLength(0);
    await store.upsert('g1', { buyBot: config({ address: 'Other' }) });
    engine.invalidate();
    await engine.refresh();
    engine.onTrade(trade());
    await engine.flush();
    expect(posts).toHaveLength(0);
  });

  it('marks a community it was removed from, and counts a post that could not go', async () => {
    const gone = await setup({ outcome: 'gone' });
    gone.engine.onTrade(trade());
    await gone.engine.flush();
    expect((await gone.store.get('g1'))!.left).toBe(true);
    expect(await gone.store.withBuyBot()).toEqual([]);

    const dropped = await setup({ outcome: () => { throw new Error('network'); } });
    dropped.engine.onTrade(trade());
    await dropped.engine.flush();
    expect(dropped.engine.getStats()).toMatchObject({ posts: 0, dropped: 1 });
  });

  it('reads the communities again when told, and again after a minute', async () => {
    const { engine, store, posts, tick } = await setup();
    await store.upsert('g2', { buyBot: config() });
    engine.onTrade(trade());
    await engine.flush();
    expect(posts.map((p) => p.id)).toEqual(['g1']);
    // A minute on, the next flush reads the store again and finds the second community.
    tick(60_000);
    await engine.flush();
    engine.onTrade(trade({ at: 160_000 }));
    await engine.flush();
    expect(posts.map((p) => p.id).sort()).toEqual(['g1', 'g1', 'g2']);
  });
});

describe('buy posts', () => {
  const links = linkTemplates();

  it('prints one buy with its size, amounts, buyer and price', () => {
    const text = toPlain(buyPostCard({ config: config(), buys: [buyOf(trade())!], windowMs: 1_000 }, links));
    expect(text).toContain('TOK buy');
    expect(text).toContain('$100.00 (0.5 SOL)');
    expect(text).toContain('5 TOK');
    expect(text).toContain('Make…1111 (https://solscan.io/account/Maker1111111111111111111111111111111111111)');
    expect(text).toContain('MC $20K · Price $0.0₄2');
    expect(text.split('\n')[1]).toBe('🟢'.repeat(4));
  });

  it('prints a whale buy, and unknown decimals as a dash', () => {
    const whale = toPlain(buyPostCard({ config: config({ decimals: null, symbol: null }), buys: [buyOf(trade({ usd: 5_000 }))!], windowMs: 1_000 }, links));
    expect(whale).toContain('Whale buy · So1a…1111');
    expect(whale).toContain('🪙 — So1a…1111');
    expect(isWhale(999, 25)).toBe(false);
    expect(isWhale(1_000, 25)).toBe(true);
    expect(isWhale(1_000, 500)).toBe(false);
  });

  it('prints merged buys with the count, the total and the biggest', () => {
    const buys = [buyOf(trade({ usd: 100, at: 1 }))!, buyOf(trade({ usd: 400, at: 2, maker: 'Big11111111111111111111111111111111111111111' }))!, buyOf(trade({ usd: 320, at: 3, mc: 31_000 }))!];
    const text = toPlain(buyPostCard({ config: config(), buys, windowMs: 10_000 }, links));
    expect(text).toContain('TOK: 3 buys · $820.00 in 10 s');
    expect(text).toContain('Biggest $400.00 by Big1…1111');
    expect(text).toContain('MC $31K');
  });

  it('fills in a symbol and decimals the source learned after the buy bot was set up', async () => {
    const post: BuyPost = { config: config({ symbol: null, decimals: null }), buys: [buyOf(trade())!], windowMs: 1_000 };
    const known = { token: async () => ({ address: MINT, symbol: 'TOK', name: 'Tok', decimals: 6, m5: { trades: 0, buys: 0, volumeUsd: null, priceChangePct: null }, lastTradeAt: null }) };
    expect((await withTokenFacts(post, known)).config).toMatchObject({ symbol: 'TOK', decimals: 6 });
    expect(await withTokenFacts(post, { token: async () => null })).toBe(post);
    expect(await withTokenFacts(post, { token: async () => { throw new Error('down'); } })).toBe(post);
    const full: BuyPost = { ...post, config: config() };
    expect(await withTokenFacts(full, known)).toBe(full);
  });

  it('sizes the bar by the minimum, between one and thirty dots', () => {
    expect(sizeBar(1, 25)).toBe('🟢');
    expect(sizeBar(250, 25)).toBe('🟢'.repeat(10));
    expect(sizeBar(1e9, 25)).toBe('🟢'.repeat(30));
    expect(sizeBar(100, 1)).toBe('🟢'.repeat(10));
  });
});
