/** The cards drawn from the chain tools' answers: a quote, a safety grade, the largest holders, the app behind a trade. */

import { describe, expect, it } from 'vitest';
import { appCard, fmtUnits, holdersCard, linkTemplates, quoteAmountIn, quoteCard, quoteToolCall, quoteViewOf, safetyCard, toPlain, toText } from '../src';

const MINT = 'FWFxnxR1Esvv6Ebcntr357ri1mucV5FiKTG1kEiBpump';
const links = linkTemplates();

describe('quote', () => {
  it('turns what somebody typed into base units, within bounds', () => {
    expect(quoteAmountIn('0.5', null)).toEqual({ units: '500000000', symbol: 'SOL', decimals: 9 });
    expect(quoteAmountIn('1,000', null)).toMatchObject({ units: '1000000000000' });
    expect(quoteAmountIn('0.0001', null)).toBeNull();
    expect(quoteAmountIn('lots', null)).toBeNull();
    expect(quoteToolCall(MINT, '500000000')).toEqual({ name: 'launchpad_quote', args: { mint: MINT, side: 'buy', amountIn: '500000000' } });
  });

  it('draws what goes in, what comes out, the least, the impact and the fee', () => {
    const result = { venue: 'pumpfun', side: 'buy', inAmount: '500000000', outAmount: '12345678900000', minOutAmount: '11975308533000', slippageBps: 300, venueFeeLamports: '5000000', priceImpactBps: 123 };
    const text = toText(quoteCard(quoteViewOf(result, { symbol: 'ZOP', decimals: 6 }), MINT, links)).split('\n');
    expect(text[0]).toBe('💱 Quote: 0.5 SOL → ZOP · on pump.fun');
    expect(text[1]).toBe('🪙 You get: 12.35M ZOP');
    expect(text[2]).toBe('🛡 At least: 11.98M ZOP at 3% slippage');
    expect(text[3]).toBe('📉 Price impact: 1.23% · Fee: 0.005 SOL');
    // Without the token's decimals the amount stays in base units; it is never guessed.
    expect(toText(quoteCard(quoteViewOf(result, null), MINT, links))).toContain('🪙 You get: 12345678900000 base units of tokens');
    expect(toText(quoteCard(quoteViewOf({ ...result, priceImpactBps: null }, null), MINT, links))).toContain('📉 Price impact: —');
  });

  it('prints base units short', () => {
    expect(fmtUnits('1500000', 6)).toBe('1.5');
    expect(fmtUnits('42', 9)).toBe('4.2e-8');
    expect(fmtUnits('1', null)).toBe('—');
  });
});

describe('safety, holders, app', () => {
  it('grades a token check by check, an unverified check never a pass', () => {
    const view = {
      report: {
        grade: 'caution',
        score: 5,
        maxScore: 8,
        unverifiedCount: 1,
        incomplete: false,
        checks: [
          { label: 'Mint authority revoked', passed: true },
          { label: 'Freeze authority revoked', passed: false, critical: true, detail: 'a wallet can freeze holders' },
          { label: 'Top 10 under 30%', passed: false, unverified: true },
        ],
      },
      warnings: ['Token-2022 transfer hook'],
    };
    const text = toText(safetyCard(view, 'ZOP', MINT, links)).split('\n');
    expect(text[0]).toBe('🛡 Safety: ZOP · 🟡 Caution · 5/8');
    expect(text.slice(1, 5)).toEqual(['✅ Mint authority revoked', '⛔ Freeze authority revoked: a wallet can freeze holders', '❔ Top 10 under 30%: not verified', '⚠️ Token-2022 transfer hook']);
    expect(text).toContain('1 check could not run; one that could not run never counts as a pass.');
  });

  it('lists the largest holders without pools, and the linked groups', () => {
    const view = {
      nodes: [
        { id: 'Pool111111111111111111111111111111111', pct: 40, type: 'pool' },
        { id: 'Whale11111111111111111111111111111111', pct: 8.5, type: 'holder', cluster: 1 },
        { id: 'Whale21111111111111111111111111111111', pct: 6, type: 'holder', cluster: 1 },
        { id: 'Small11111111111111111111111111111111', pct: null, type: 'holder' },
      ],
      clusters: [{ id: 1, pct: 14.5, wallets: 2 }],
    };
    const lines = holdersCard(view, 'ZOP', MINT, links);
    const text = toText(lines).split('\n');
    expect(text[1]).toBe('1. Whal…1111 8.5% · group 1');
    expect(text[3]).toBe('3. Smal…1111 —');
    // One unknown share makes the sum unknown, never a smaller number.
    expect(text[4]).toBe('Top 3: —');
    expect(text[5]).toBe('🔗 1 linked group; the largest is 2 wallets holding 14.5%');
    expect(toPlain(lines)).toContain(`🫧 Open the holder map (https://soltoolkit-live.vercel.app/#/token/${MINT})`);
  });

  it('names the app behind a trade, or says it is unknown rather than none', () => {
    expect(toText(appCard({ signature: 'sig', platform: 'Axiom', by: 'fee-wallet', evidence: 'Fee1111111111111111111111111111111111' }, links))).toContain('🔎 Placed with Axiom\nHow it is known: its fee wallet was paid (Fee1…1111).');
    expect(toText(appCard({ signature: 'sig', platform: null, by: null, evidence: null, failed: true }, links))).toContain('unknown, not "none"');
  });
});

describe('offered commands', () => {
  it('lists a tool command only when the tools have its tool', async () => {
    const { offeredCommands } = await import('../src');
    const commands = [{ command: 'ca' }, { command: 'quote' }, { command: 'safety' }];
    expect(offeredCommands(commands, null).map((c) => c.command)).toEqual(['ca']);
    expect(offeredCommands(commands, { tools: ['launchpad_quote'] }).map((c) => c.command)).toEqual(['ca', 'quote']);
    expect(offeredCommands([{ name: 'holders' }, { name: 'help' }], { tools: ['holder_map'] }).map((c) => c.name)).toEqual(['holders', 'help']);
  });
});

describe('terminal', () => {
  it('prints bold figures and underlined link words, and drops escape codes from outside text', async () => {
    const { toAnsi } = await import('../src');
    expect(toAnsi([['MC ', { value: '$4K' }, ' ', { link: 'EXP', url: 'https://x' }, ' ', { bold: '\u001b[31mred' }]])).toBe('MC \u001b[1m$4K\u001b[0m \u001b[4mEXP\u001b[0m \u001b[1m[31mred\u001b[0m');
  });
});
