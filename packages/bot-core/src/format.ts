/** How figures are printed. Unknown prints as a dash, never as zero. */

export const DASH = '—';

const trimZeros = (text: string): string => (text.includes('.') ? text.replace(/\.?0+$/, '') : text);

const SUBSCRIPT = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];

/** `0.0₅123` for a value with many leading zeros, the way trading terminals print it. */
function fmtSmall(value: number): string {
  const fixed = value.toFixed(12);
  const match = /^0\.(0+)(\d+)$/.exec(fixed);
  if (!match) return trimZeros(value.toFixed(6));
  const zeros = match[1]!.length;
  const digits = match[2]!.replace(/0+$/, '').slice(0, 4) || '0';
  if (zeros < 3) return trimZeros(value.toFixed(zeros + 4));
  return `0.0${String(zeros)
    .split('')
    .map((d) => SUBSCRIPT[Number(d)])
    .join('')}${digits}`;
}

const known = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value);

/** `$1.23`, `$12.3K`, `$4.56M`, `$1.2B`. */
export function fmtUsd(value: number | null | undefined): string {
  if (!known(value)) return DASH;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const scaled =
    abs >= 1e9
      ? `${trimZeros((abs / 1e9).toFixed(2))}B`
      : abs >= 1e6
        ? `${trimZeros((abs / 1e6).toFixed(2))}M`
        : abs >= 1e4
          ? `${trimZeros((abs / 1e3).toFixed(1))}K`
          : abs >= 0.01
            ? abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : abs === 0
              ? '0.00'
              : fmtSmall(abs);
  return `${sign}$${scaled}`;
}

export function fmtPrice(value: number | null | undefined): string {
  if (!known(value)) return DASH;
  if (value >= 1000) return `$${Math.round(value).toLocaleString('en-US')}`;
  if (value >= 1) return `$${trimZeros(value.toFixed(4))}`;
  if (value >= 0.001) return `$${trimZeros(value.toFixed(6))}`;
  if (value <= 0) return '$0';
  return `$${fmtSmall(value)}`;
}

export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (!known(value)) return DASH;
  return `${value > 0 ? '+' : ''}${trimZeros(value.toFixed(digits)) || '0'}%`;
}

export function fmtNum(value: number | null | undefined, maxFraction = 2): string {
  if (!known(value)) return DASH;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trimZeros((value / 1e9).toFixed(2))}B`;
  if (abs >= 1e6) return `${trimZeros((value / 1e6).toFixed(2))}M`;
  if (abs >= 1e4) return `${trimZeros((value / 1e3).toFixed(1))}K`;
  return value.toLocaleString('en-US', { maximumFractionDigits: maxFraction });
}

/** Base units as a decimal string of whole units, exactly (`1500000`, 6 → `1.5`); null when it cannot be read. */
export function fromBaseUnits(baseUnits: string | null | undefined, decimals: number | null | undefined): string | null {
  if (!baseUnits || decimals === null || decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  if (!/^\d+$/.test(baseUnits)) return null;
  const units = BigInt(baseUnits);
  const scale = 10n ** BigInt(decimals);
  const fraction = decimals === 0 ? '' : (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${units / scale}.${fraction}` : `${units / scale}`;
}

/** A token amount in base units, printed in whole tokens; unknown decimals print a dash. */
export function fmtTokenAmount(baseUnits: string | null | undefined, decimals: number | null | undefined): string {
  const whole = fromBaseUnits(baseUnits, decimals);
  if (whole === null) return DASH;
  const value = Number(whole);
  if (!Number.isFinite(value)) return DASH;
  if (value >= 1) return fmtNum(value, value >= 100 ? 0 : 2);
  return trimZeros(value.toFixed(Math.min(decimals ?? 6, 6))) || '0';
}

/** Lamports as SOL: `0.8889 SOL`. */
export function fmtSol(lamports: string | null | undefined): string {
  const whole = fromBaseUnits(lamports, 9);
  if (whole === null) return DASH;
  const value = Number(whole);
  return `${trimZeros(value.toFixed(value >= 100 ? 2 : 4)) || '0'} SOL`;
}

export const shortAddr = (address: string): string => (address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address);

/** `45s`, `12m`, `3h`, `2d`. */
export function ago(at: number | null | undefined, now: number = Date.now()): string {
  if (!at) return DASH;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}
