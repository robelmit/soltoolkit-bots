/**
 * Two budgets. `CardLimiter` keeps a bot from answering the same address over
 * and over in one community. `SendSlots` keeps a bot inside the sending rates
 * its platform enforces: it hands out the earliest moment a message may go to
 * a chat, and a caller that would wait too long drops the message instead of
 * queueing it without end — a buy post that arrives a minute late is worse
 * than none.
 */

/** One card per address per `perAddressMs` in a community, at most `perMinute` cards a minute there. */
export class CardLimiter {
  private readonly lastByAddress = new Map<string, number>();
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly perMinute = 10,
    private readonly perAddressMs = 120_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a card for `address` may go to `communityId` now; a yes counts. */
  allow(communityId: string, address: string): boolean {
    const at = this.now();
    const key = `${communityId}:${address}`;
    const last = this.lastByAddress.get(key);
    if (last !== undefined && at - last < this.perAddressMs) return false;
    const window = (this.windows.get(communityId) ?? []).filter((t) => at - t < 60_000);
    if (window.length >= this.perMinute) {
      this.windows.set(communityId, window);
      return false;
    }
    window.push(at);
    this.windows.set(communityId, window);
    this.lastByAddress.set(key, at);
    if (this.lastByAddress.size > 50_000) this.lastByAddress.clear();
    if (this.windows.size > 50_000) this.windows.clear();
    return true;
  }
}

export interface SendLimits {
  /** Messages a minute in one chat. */
  readonly perMinute: number;
  /** The least gap between two messages in one chat, in milliseconds. */
  readonly gapMs: number;
  /** Messages a second across the whole bot. */
  readonly globalPerSecond: number;
}

interface ChatSlots {
  /** Reserved send times of the last minute, ascending. */
  times: number[];
  blockedUntil: number;
}

export class SendSlots {
  private readonly chats = new Map<string, ChatSlots>();
  private global: number[] = [];

  constructor(
    private readonly limits: (chatId: string) => SendLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /** The earliest time a message may go to `chatId`: its minute window, its gap, a block, and the bot's own rate. */
  next(chatId: string): number {
    const at = this.now();
    const limits = this.limits(chatId);
    const chat = this.chats.get(chatId) ?? { times: [], blockedUntil: 0 };
    let t = Math.max(at, chat.blockedUntil);
    for (let guard = 0; guard < 100; guard += 1) {
      const before = t;
      const last = chat.times[chat.times.length - 1];
      if (last !== undefined && t < last + limits.gapMs) t = last + limits.gapMs;
      const inMinute = chat.times.filter((x) => x > t - 60_000);
      if (inMinute.length >= limits.perMinute) t = Math.max(t, inMinute[inMinute.length - limits.perMinute]! + 60_000);
      const inSecond = this.global.filter((x) => x > t - 1_000 && x <= t);
      if (inSecond.length >= limits.globalPerSecond) t = Math.max(t, inSecond[inSecond.length - limits.globalPerSecond]! + 1_000);
      if (t === before) return t;
    }
    return t;
  }

  /** Takes the slot at `t` for `chatId`. */
  reserve(chatId: string, t: number): void {
    const at = this.now();
    const chat = this.chats.get(chatId) ?? { times: [], blockedUntil: 0 };
    chat.times = [...chat.times.filter((x) => x > at - 60_000), t].sort((a, b) => a - b);
    this.chats.set(chatId, chat);
    this.global = [...this.global.filter((x) => x > at - 1_000), t].sort((a, b) => a - b);
    if (this.chats.size > 20_000) {
      for (const [id, slots] of this.chats) if (!slots.times.some((x) => x > at - 60_000) && slots.blockedUntil < at) this.chats.delete(id);
    }
  }

  /** The platform refused the chat for `ms` (a rate-limit answer): nothing goes there before it passes. */
  block(chatId: string, ms: number): void {
    const chat = this.chats.get(chatId) ?? { times: [], blockedUntil: 0 };
    chat.blockedUntil = this.now() + Math.max(0, ms);
    this.chats.set(chatId, chat);
  }
}
