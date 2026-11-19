/**
 * Alerts, with no bot library in them. A community switches on:
 *
 * - **launches**: a token younger than an hour, posted the first time its market cap reaches the community's
 *   minimum (default $20K), from one launchpad or all;
 * - **graduations**: a token that finished its bonding curve and moved to a pool;
 *
 * and a community with a buy bot hears when the tracked token's creator sells, with nothing to set: the first sale
 * the feed shows from the creator's wallet (**dev selling**), and the feed saying the creator sold out (**dev sold**).
 *
 * Each kind posts at most once a minute per community (the dev alerts at once), a token at most once per community
 * and kind, and an alert that waited more than three minutes is dropped: late news is worse than none. Sending is
 * the caller's.
 */

import { launchpadId, launchpadLabel, tokenCard, type CardExtras } from './cards';
import { fmtShort, shortAddr } from './format';
import { tokenUrl, txUrl, walletUrl, type LinkTemplates } from './links';
import type { Line } from './rich';
import type { PostOutcome } from './buybot';
import { alertsOn } from './store';
import type { TokenChange } from './feed';
import type { CommunityRecord, FeedTrade, Logger, Store, TokenView } from './types';
import { silentLogger } from './types';

export type AlertKind = 'launch' | 'graduation' | 'devSell' | 'devSold';

export interface Alert {
  readonly kind: AlertKind;
  readonly address: string;
  readonly at: number;
  /** For a dev sale seen on a trade: its dollar value, when known, and the transaction. */
  readonly usd?: number | null;
  readonly tx?: string;
}

/** The dev alerts go out at once; the others once a minute. */
export const isDevAlert = (kind: AlertKind): boolean => kind === 'devSell' || kind === 'devSold';

/** A launch alert is for tokens younger than this. */
export const LAUNCH_MAX_AGE_MS = 60 * 60_000;
export const DEFAULT_LAUNCH_MIN_MC = 20_000;
export const LAUNCH_MIN_MC_RANGE = Object.freeze({ min: 1_000, max: 100_000_000 });
/** The least time between two alerts of one kind in one community. */
export const ALERT_GAP_MS = 60_000;
/** An alert that waited longer than this is dropped. */
export const ALERT_MAX_AGE_MS = 3 * 60_000;

export interface AlertStats {
  changes: number;
  queued: number;
  posts: number;
  dropped: number;
  communities: number;
}

export interface AlertEngineOptions {
  readonly store: Store;
  /** Sends one alert to one community. `gone`: the bot is no longer there. */
  readonly post: (community: CommunityRecord, alert: Alert) => Promise<PostOutcome>;
  readonly log?: Logger;
  readonly now?: () => number;
  /** How often waiting alerts are looked at (default 2 s). */
  readonly flushMs?: number;
  readonly gapMs?: number;
  /** How often the communities are read again from the store (default 60 s). */
  readonly reloadMs?: number;
  /** The wallet that created a token, when known (`feed.creatorOf`): a sale from it is a dev sale. */
  readonly creatorOf?: (address: string) => string | null;
}

const known = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
/** A dev sale older than this when it is read is not news. */
const DEV_SALE_MAX_AGE_MS = 60_000;

export class AlertEngine {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly gapMs: number;
  private launchWatchers: CommunityRecord[] = [];
  private graduationWatchers: CommunityRecord[] = [];
  private devWatchers = new Map<string, CommunityRecord[]>();
  private byCommunity = new Map<string, CommunityRecord>();
  private readonly pending = new Map<string, Alert[]>();
  private readonly seen = new Map<string, Set<string>>();
  private readonly lastPost = new Map<string, number>();
  private loadedAt = 0;
  private stale = true;
  private flushing = false;
  private readonly stats: AlertStats = { changes: 0, queued: 0, posts: 0, dropped: 0, communities: 0 };

  constructor(private readonly options: AlertEngineOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? silentLogger;
    this.gapMs = options.gapMs ?? ALERT_GAP_MS;
  }

  getStats(): Readonly<AlertStats> {
    return { ...this.stats };
  }

  /** A community changed its alerts or its buy bot: read them again before the next alert. */
  invalidate(): void {
    this.stale = true;
  }

  /** Give every trade of the feed to this (`feed.onTrade(alerts.onTrade)`): it finds the creator's sales. */
  readonly onTrade = (trade: FeedTrade): void => {
    if (trade.side !== 'sell' || !this.options.creatorOf) return;
    const watchers = this.devWatchers.get(trade.address);
    if (!watchers || this.now() - trade.at > DEV_SALE_MAX_AGE_MS) return;
    const creator = this.options.creatorOf(trade.address);
    // EVM addresses may come in either case; Solana's are case-sensitive.
    const same = !!creator && (creator === trade.maker || (creator.startsWith('0x') && creator.toLowerCase() === trade.maker.toLowerCase()));
    if (!same) return;
    for (const community of watchers) this.queue(community, { kind: 'devSell', address: trade.address, at: this.now(), usd: trade.usd, tx: trade.tx });
  };

  /** Give every token change of the feed to this (`feed.onToken(alerts.onToken)`). */
  readonly onToken = (change: TokenChange): void => {
    this.stats.changes += 1;
    const { before, after } = change;
    const at = this.now();
    if (before && before.risk?.devSold !== true && after.risk?.devSold === true) {
      for (const community of this.devWatchers.get(after.address) ?? []) this.queue(community, { kind: 'devSold', address: after.address, at });
    }
    if (before && before.stage !== 'migrated' && after.stage === 'migrated') {
      for (const community of this.graduationWatchers) this.queue(community, { kind: 'graduation', address: after.address, at });
    }
    if (this.launchWatchers.length && known(after.mc) && known(after.createdAt) && at - after.createdAt <= LAUNCH_MAX_AGE_MS) {
      const was = before?.mc;
      for (const community of this.launchWatchers) {
        const rule = community.alerts?.launches;
        if (!rule || (rule.launchpad && after.launchpad !== rule.launchpad)) continue;
        // The first time it reaches the minimum: from below, or seen for the first time already above it.
        if (after.mc >= rule.minMc && (!known(was) || was < rule.minMc)) this.queue(community, { kind: 'launch', address: after.address, at });
      }
    }
  };

  private queue(community: CommunityRecord, alert: Alert): void {
    const key = `${alert.kind}:${alert.address}`;
    let seen = this.seen.get(community.id);
    if (!seen) this.seen.set(community.id, (seen = new Set()));
    if (seen.has(key)) return;
    if (seen.size > 5_000) seen.clear();
    seen.add(key);
    const list = this.pending.get(community.id) ?? [];
    list.push(alert);
    if (list.length > 50) list.splice(0, list.length - 50);
    this.pending.set(community.id, list);
    this.stats.queued += 1;
  }

  /** Reads the communities with alerts or a buy bot again: after a change, and every minute. */
  async refresh(): Promise<void> {
    if (!this.stale && this.now() - this.loadedAt < (this.options.reloadMs ?? 60_000)) return;
    this.stale = false;
    const [alertRows, buyRows] = await Promise.all([this.options.store.withAlerts?.() ?? Promise.resolve([]), this.options.store.withBuyBot()]);
    const byCommunity = new Map<string, CommunityRecord>();
    const launches: CommunityRecord[] = [];
    const graduations: CommunityRecord[] = [];
    const dev = new Map<string, CommunityRecord[]>();
    for (const row of alertRows) {
      if (row.left || !alertsOn(row.alerts)) continue;
      byCommunity.set(row.id, row);
      if (row.alerts.launches) launches.push(row);
      if (row.alerts.graduations) graduations.push(row);
    }
    for (const row of buyRows) {
      if (row.left || !row.buyBot) continue;
      byCommunity.set(row.id, row);
      dev.set(row.buyBot.address, [...(dev.get(row.buyBot.address) ?? []), row]);
    }
    this.byCommunity = byCommunity;
    this.launchWatchers = launches;
    this.graduationWatchers = graduations;
    this.devWatchers = dev;
    this.stats.communities = byCommunity.size;
    this.loadedAt = this.now();
  }

  /** Posts, per community, the oldest waiting alert whose kind may post again; drops the ones that waited too long. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      await this.refresh().catch((error: unknown) => {
        this.stale = true;
        this.log.warn('alerts: the communities could not be read', { error: error instanceof Error ? error.message : String(error) });
      });
      const at = this.now();
      const due: { community: CommunityRecord; alert: Alert }[] = [];
      for (const [id, list] of [...this.pending]) {
        const fresh = list.filter((a) => at - a.at <= ALERT_MAX_AGE_MS);
        this.stats.dropped += list.length - fresh.length;
        const community = this.byCommunity.get(id);
        const i = fresh.findIndex((a) => isDevAlert(a.kind) || at - (this.lastPost.get(`${id}:${a.kind}`) ?? -Infinity) >= this.gapMs);
        if (!community || i < 0) {
          if (!community) this.pending.delete(id);
          else this.pending.set(id, fresh);
          continue;
        }
        const [alert] = fresh.splice(i, 1);
        if (fresh.length) this.pending.set(id, fresh);
        else this.pending.delete(id);
        this.lastPost.set(`${id}:${alert!.kind}`, at);
        due.push({ community, alert: alert! });
      }
      for (let i = 0; i < due.length; i += 25) await Promise.all(due.slice(i, i + 25).map((d) => this.send(d.community, d.alert)));
    } finally {
      this.flushing = false;
    }
  }

  private async send(community: CommunityRecord, alert: Alert): Promise<void> {
    let outcome: PostOutcome;
    try {
      outcome = await this.options.post(community, alert);
    } catch (error) {
      this.log.warn('alerts: a post failed', { community: community.id, kind: alert.kind, error: error instanceof Error ? error.message : String(error) });
      outcome = 'failed';
    }
    if (outcome === 'sent') this.stats.posts += 1;
    else if (outcome === 'gone') {
      await this.options.store.upsert(community.id, { left: true }).catch(() => undefined);
      this.invalidate();
    } else this.stats.dropped += 1;
  }

  /** Flushes on a timer until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.flush().catch((error: unknown) => this.log.warn('alerts: flush failed', { error: error instanceof Error ? error.message : String(error) }));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.flushMs ?? 2_000);
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      });
    }
  }
}

/** What an alert says: a heading over the token's card, or for a dev sale a short warning. */
export function alertCard(alert: Alert, token: TokenView, community: CommunityRecord, links: LinkTemplates, now: number, extras: CardExtras = {}): Line[] {
  if (isDevAlert(alert.kind)) {
    const sold = alert.kind === 'devSold';
    const lines: Line[] = [
      ['🚨 ', { bold: `${sold ? 'Dev sold' : 'Dev selling'} ${token.symbol}` }],
      [sold ? 'The wallet that created the token sold out of it.' : `The wallet that created the token just sold${known(alert.usd) ? ` $${fmtShort(alert.usd)} of it` : ''}.`],
    ];
    lines.push([
      '💎 MC: ',
      { value: token.mc ? `$${fmtShort(token.mc)}` : '—' },
      ' · ',
      { link: 'token', url: tokenUrl(links, token.address) },
      ...(token.creator ? [' · ', { link: `dev ${shortAddr(token.creator)}`, url: walletUrl(links, token.creator) }] : []),
      ...(alert.tx ? [' · ', { link: 'tx', url: txUrl(links, alert.tx) }] : []),
    ]);
    lines.push([{ code: token.address }]);
    return lines;
  }
  const heading: Line =
    alert.kind === 'launch'
      ? ['🚀 ', { bold: `New launch past $${fmtShort(community.alerts?.launches?.minMc ?? DEFAULT_LAUNCH_MIN_MC)}` }, community.alerts?.launches?.launchpad ? ` on ${launchpadLabel(community.alerts.launches.launchpad)}` : '']
      : ['🎓 ', { bold: `Graduated${token.launchpad ? ` from ${launchpadLabel(token.launchpad)}` : ''}` }];
  return [heading, [''], ...tokenCard(token, links, now, extras)];
}

/**
 * `/launches` arguments as a community types them: `on`, `on 50k`, `on 50k pump.fun`, `off`. A launchpad the kit
 * does not know is refused rather than guessed.
 */
export function parseLaunchArgs(text: string): { readonly on: false } | { readonly on: true; readonly minMc: number; readonly launchpad: string | null } | { readonly error: string } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const mode = words.shift()?.toLowerCase();
  if (mode === 'off') return { on: false };
  if (mode !== 'on') return { error: 'Send /launches on [market cap] [launchpad], such as /launches on 50k pump.fun, or /launches off.' };
  let minMc = DEFAULT_LAUNCH_MIN_MC;
  let launchpad: string | null = null;
  for (const word of words) {
    const amount = /^\$?[\d.,]+[km]?$/i.test(word) ? parseMoney(word) : null;
    if (amount !== null) {
      if (amount < LAUNCH_MIN_MC_RANGE.min || amount > LAUNCH_MIN_MC_RANGE.max) return { error: `The market cap is from $${fmtShort(LAUNCH_MIN_MC_RANGE.min)} to $${fmtShort(LAUNCH_MIN_MC_RANGE.max)}.` };
      minMc = amount;
      continue;
    }
    const id = launchpadId(word);
    if (!id) return { error: `"${word.slice(0, 40)}" is not a launchpad this bot knows.` };
    launchpad = id;
  }
  return { on: true, minMc, launchpad };
}

function parseMoney(raw: string): number | null {
  const text = raw.replace(/^\$/, '').replace(/,/g, '').toLowerCase();
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]) * (match[2] === 'k' ? 1_000 : match[2] === 'm' ? 1_000_000 : 1);
  return Number.isFinite(value) ? value : null;
}
