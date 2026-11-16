/** Finding a token address in what somebody typed. */

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const EDGE = /^[^1-9A-HJ-NP-Za-km-z]+|[^1-9A-HJ-NP-Za-km-z]+$/g;

export const isSolanaAddress = (text: string): boolean => SOLANA_ADDRESS.test(text);

/**
 * The first Solana address in a text: bare, or inside a link (a token page, a
 * block explorer, a launchpad page). A mint is base58 of 32 to 44 characters,
 * so tickers, amounts and ordinary words never match.
 */
export function detectAddress(text: string): string | null {
  for (const raw of text.split(/[\s,;]+/)) {
    const word = raw.trim();
    if (!word) continue;
    // In a link the address is a path segment or a query value.
    const candidates = word.includes('/') || word.includes('=') ? word.split(/[/=?#&]/).filter(Boolean) : [word];
    for (const candidate of candidates.reverse()) {
      // Punctuation around it ("…pump?", "(…pump)") is not part of the address.
      const bare = candidate.replace(EDGE, '');
      if (SOLANA_ADDRESS.test(bare)) return bare;
    }
  }
  return null;
}

/** A least-buy amount in dollars as an admin types it (`25`, `$1,000`, `2.5k`); null when it is not one. */
export function parseUsd(raw: string): number | null {
  const text = raw.trim().replace(/^\$/, '').replace(/,/g, '').toLowerCase();
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]) * (match[2] === 'k' ? 1_000 : match[2] === 'm' ? 1_000_000 : 1);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}
