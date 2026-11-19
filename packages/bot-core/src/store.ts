/**
 * Where a bot keeps what its communities set. Two stores ship: one in memory
 * (tests, a throwaway run) and one in a single JSON file, written whole and
 * swapped into place, so a crash mid-write leaves the last good file. A bot
 * with thousands of communities wants a database; the `Store` interface is
 * four methods.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AlertConfig, BuyBotConfig, Call, CommunityPatch, CommunityRecord, Store } from './types';

function applyPatch(current: CommunityRecord | undefined, id: string, patch: CommunityPatch, at: number): CommunityRecord {
  const base: CommunityRecord = current ?? { id, title: null, buyBot: null, alerts: null, calls: [], left: false, updatedAt: at };
  return {
    id,
    title: patch.title !== undefined ? patch.title : base.title,
    buyBot: patch.buyBot !== undefined ? patch.buyBot : base.buyBot,
    alerts: patch.alerts !== undefined ? patch.alerts : (base.alerts ?? null),
    calls: patch.calls !== undefined ? patch.calls : (base.calls ?? []),
    left: patch.left !== undefined ? patch.left : base.left,
    updatedAt: at,
  };
}

/** Whether a community's alerts have anything switched on. */
export const alertsOn = (alerts: AlertConfig | null | undefined): alerts is AlertConfig => !!alerts && (alerts.launches !== null || alerts.graduations !== null);

export class MemoryStore implements Store {
  protected readonly rows = new Map<string, CommunityRecord>();

  constructor(protected readonly now: () => number = Date.now) {}

  async get(id: string): Promise<CommunityRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async upsert(id: string, patch: CommunityPatch): Promise<CommunityRecord> {
    const next = applyPatch(this.rows.get(id), id, patch, this.now());
    this.rows.set(id, next);
    await this.changed();
    return next;
  }

  async withBuyBot(): Promise<CommunityRecord[]> {
    return [...this.rows.values()].filter((row) => row.buyBot !== null && !row.left);
  }

  async withAlerts(): Promise<CommunityRecord[]> {
    return [...this.rows.values()].filter((row) => alertsOn(row.alerts) && !row.left);
  }

  async migrate(fromId: string, toId: string): Promise<void> {
    const old = this.rows.get(fromId);
    if (!old) return;
    const target = this.rows.get(toId);
    const at = this.now();
    this.rows.set(toId, {
      id: toId,
      title: target?.title ?? old.title,
      buyBot: target?.buyBot ?? old.buyBot,
      alerts: target?.alerts ?? old.alerts ?? null,
      calls: [...(old.calls ?? []), ...(target?.calls ?? [])],
      left: false,
      updatedAt: at,
    });
    this.rows.set(fromId, { ...old, buyBot: null, alerts: null, left: true, updatedAt: at });
    await this.changed();
  }

  protected async changed(): Promise<void> {}
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function readBuyBot(value: unknown): BuyBotConfig | null {
  if (!isRecord(value) || typeof value.address !== 'string' || typeof value.minUsd !== 'number' || !Number.isFinite(value.minUsd)) return null;
  const kind = isRecord(value.media) ? value.media.kind : null;
  const fileId = isRecord(value.media) ? value.media.fileId : null;
  const media: BuyBotConfig['media'] = (kind === 'photo' || kind === 'animation') && typeof fileId === 'string' ? { kind, fileId } : null;
  return {
    address: value.address,
    symbol: typeof value.symbol === 'string' ? value.symbol : null,
    decimals: typeof value.decimals === 'number' && Number.isInteger(value.decimals) ? value.decimals : null,
    minUsd: value.minUsd,
    media,
    channelId: typeof value.channelId === 'string' ? value.channelId : null,
    setBy: typeof value.setBy === 'string' ? value.setBy : null,
    setAt: typeof value.setAt === 'number' ? value.setAt : 0,
  };
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function readAlerts(value: unknown): AlertConfig | null {
  if (!isRecord(value)) return null;
  const l = isRecord(value.launches) && positive(value.launches.minMc) ? { minMc: value.launches.minMc, launchpad: typeof value.launches.launchpad === 'string' ? value.launches.launchpad : null } : null;
  const g = isRecord(value.graduations) ? ({ on: true } as const) : null;
  if (!l && !g) return null;
  return { launches: l, graduations: g, channelId: typeof value.channelId === 'string' ? value.channelId : null, setBy: typeof value.setBy === 'string' ? value.setBy : null, setAt: typeof value.setAt === 'number' ? value.setAt : 0 };
}

function readCalls(value: unknown): Call[] {
  if (!Array.isArray(value)) return [];
  const calls: Call[] = [];
  for (const c of value) {
    if (!isRecord(c) || typeof c.address !== 'string' || typeof c.by !== 'string' || typeof c.byId !== 'string' || typeof c.at !== 'number') continue;
    calls.push({ address: c.address, symbol: typeof c.symbol === 'string' ? c.symbol : null, by: c.by, byId: c.byId, mc: positive(c.mc) ? c.mc : null, at: c.at });
  }
  return calls;
}

/** The rows of a store file; anything that is not a row is left out. */
export function readRows(text: string): CommunityRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('the store file is not JSON');
  }
  const list = isRecord(parsed) && Array.isArray(parsed.communities) ? parsed.communities : null;
  if (!list) throw new Error('the store file has no "communities" list');
  const rows: CommunityRecord[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) continue;
    rows.push({
      id: item.id,
      title: typeof item.title === 'string' ? item.title : null,
      buyBot: readBuyBot(item.buyBot),
      alerts: readAlerts(item.alerts),
      calls: readCalls(item.calls),
      left: item.left === true,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    });
  }
  return rows;
}

/**
 * The store in one JSON file. `open` reads it (a missing file is an empty store; a file that does not parse is an
 * error, never silently replaced). Every change rewrites the file through a temporary one; writes run one at a time.
 */
export class JsonFileStore extends MemoryStore {
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    now: () => number,
  ) {
    super(now);
  }

  static async open(path: string, now: () => number = Date.now): Promise<JsonFileStore> {
    const store = new JsonFileStore(path, now);
    let text: string | null = null;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (text !== null && text.trim()) for (const row of readRows(text)) store.rows.set(row.id, row);
    return store;
  }

  protected override async changed(): Promise<void> {
    const body = `${JSON.stringify({ version: 1, communities: [...this.rows.values()] }, null, 2)}\n`;
    const write = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, body, 'utf8');
      await rename(temporary, this.path);
    });
    // A failed write must not block the ones after it; the caller of this change still hears of it.
    this.writing = write.catch(() => undefined);
    await write;
  }
}
