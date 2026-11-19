/**
 * One sender for everything the bot posts on its own (buy posts, cards for a
 * pasted address), so the rates Telegram enforces are kept in one place:
 * about one message a second in a chat, about 20 a minute in a group, about
 * 30 a second across the bot (https://core.telegram.org/bots/faq).
 *
 * A send takes the earliest slot its chat and the bot both allow. When that
 * slot is further away than the caller will wait, the message is dropped and
 * counted, never queued without end. A 429 holds the chat back for the
 * `retry_after` Telegram names and tries once more if that still fits the
 * wait. MarkdownV2 that Telegram refuses is sent again as plain text.
 */

import { SendSlots, toMarkdownV2, toPlain, type Line, type LinkButton, type PostOutcome, type SendLimits } from '@soltoolkit/bot-core';
import { GrammyError, InlineKeyboard, type Api } from 'grammy';

export interface OutboxResult {
  readonly outcome: PostOutcome;
  readonly messageId?: number;
}

export interface OutboxSendOptions {
  /** What the message is, for the counters: `buy`, `card`, … */
  readonly kind: string;
  readonly buttons?: readonly LinkButton[];
  /** The card's own buttons, on a row of their own. */
  readonly actions?: CardActions;
  /** A picture shown small above the text, as the message's link preview. */
  readonly previewUrl?: string | null;
  /** How long the caller will wait for a slot (default 5 s). */
  readonly maxWaitMs?: number;
}

/** Copy CA (Telegram copies the address itself) and Refresh (a callback, `r:<address>`). */
export interface CardActions {
  readonly copy?: string;
  readonly refresh?: string;
}

export const REFRESH_PREFIX = 'r:';

export interface OutboxMedia {
  readonly kind: 'photo' | 'animation';
  readonly fileId: string;
}

export interface OutboxLimits {
  /** Messages a minute in one group or channel (Telegram: about 20). */
  readonly groupPerMinute: number;
  /** Messages a minute in one private chat. */
  readonly privatePerMinute: number;
  /** The least gap between two messages in one chat (Telegram: about a second). */
  readonly chatGapMs: number;
  /** Messages a second across the bot (Telegram: about 30). */
  readonly globalPerSecond: number;
}

/** A little under what Telegram allows, so a command's direct reply still fits beside the bot's own posts. */
export const DEFAULT_OUTBOX_LIMITS: OutboxLimits = Object.freeze({ groupPerMinute: 18, privatePerMinute: 30, chatGapMs: 1_000, globalPerSecond: 25 });

/**
 * The chat is gone for the bot: removed, blocked, deleted, or upgraded to a supergroup (whose new id the bot moves
 * the settings to). A missing right ("not enough rights to send animations") is not gone: the bot is still there,
 * and the message counts as failed.
 */
const GONE = /chat not found|user is deactivated|bot was blocked|bot was kicked|bot is not a member|chat_id is empty|upgraded to a supergroup/i;

export const isParseError = (error: unknown): boolean => error instanceof GrammyError && /can't parse entities/i.test(error.description);

export const MD = { parse_mode: 'MarkdownV2' as const, link_preview_options: { is_disabled: true } };

/** The link preview of a message: a picture shown small above the text, or none. Only https pictures are shown. */
export function previewOf(url: string | null | undefined): { link_preview_options: { is_disabled: true } | { url: string; prefer_small_media: true; show_above_text: true } } {
  if (url) {
    try {
      if (new URL(url).protocol === 'https:') return { link_preview_options: { url, prefer_small_media: true, show_above_text: true } };
    } catch {
      // Not a URL: no preview.
    }
  }
  return { link_preview_options: { is_disabled: true } };
}

/** Link buttons as one row of an inline keyboard, the card's own buttons on a second; undefined when there are none. */
export function keyboardOf(buttons: readonly LinkButton[] | undefined, actions: CardActions = {}): InlineKeyboard | undefined {
  if (!buttons?.length && !actions.copy && !actions.refresh) return undefined;
  const keyboard = new InlineKeyboard();
  for (const button of buttons ?? []) keyboard.url(button.label, button.url);
  if (actions.copy || actions.refresh) {
    if (buttons?.length) keyboard.row();
    if (actions.copy) keyboard.copyText('📋 Copy CA', actions.copy);
    if (actions.refresh) keyboard.text('♻️ Refresh', `${REFRESH_PREFIX}${actions.refresh}`);
  }
  return keyboard;
}

type SendApi = Pick<Api, 'sendMessage' | 'sendPhoto' | 'sendAnimation'>;

export type OutboxStats = Record<string, { sent: number; dropped: number; gone: number; failed: number; limited: number }>;

/** Whether a chat id is a group, supergroup or channel (negative) rather than a private chat. */
export const isGroupish = (chatId: string): boolean => chatId.startsWith('-');

export class Outbox {
  private readonly slots: SendSlots;
  private readonly stats: OutboxStats = {};
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly api: SendApi,
    options: { limits?: Partial<OutboxLimits>; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    const limits = { ...DEFAULT_OUTBOX_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
    const of = (chatId: string): SendLimits => ({ perMinute: isGroupish(chatId) ? limits.groupPerMinute : limits.privatePerMinute, gapMs: limits.chatGapMs, globalPerSecond: limits.globalPerSecond });
    this.slots = new SendSlots(of, this.now);
  }

  getStats(): OutboxStats {
    return JSON.parse(JSON.stringify(this.stats)) as OutboxStats;
  }

  async text(chatId: string, lines: readonly Line[], options: OutboxSendOptions): Promise<OutboxResult> {
    const keyboard = keyboardOf(options.buttons, options.actions);
    const markup = keyboard ? { reply_markup: keyboard } : {};
    const preview = previewOf(options.previewUrl);
    return this.deliver(chatId, options, async (asPlain) => {
      const sent = asPlain ? await this.api.sendMessage(chatId, toPlain(lines), { ...preview, ...markup }) : await this.api.sendMessage(chatId, toMarkdownV2(lines), { ...MD, ...preview, ...markup });
      return sent.message_id;
    });
  }

  /** A photo or GIF with the lines as its caption. */
  async media(chatId: string, media: OutboxMedia, lines: readonly Line[], options: OutboxSendOptions): Promise<OutboxResult> {
    const keyboard = keyboardOf(options.buttons);
    return this.deliver(chatId, options, async (asPlain) => {
      const other = { ...(asPlain ? { caption: toPlain(lines) } : { caption: toMarkdownV2(lines), parse_mode: 'MarkdownV2' as const }), ...(keyboard ? { reply_markup: keyboard } : {}) };
      const sent = media.kind === 'photo' ? await this.api.sendPhoto(chatId, media.fileId, other) : await this.api.sendAnimation(chatId, media.fileId, other);
      return sent.message_id;
    });
  }

  private count(kind: string, field: keyof OutboxStats[string]): void {
    const row = (this.stats[kind] ??= { sent: 0, dropped: 0, gone: 0, failed: 0, limited: 0 });
    row[field] += 1;
  }

  private async deliver(chatId: string, options: OutboxSendOptions, send: (asPlain: boolean) => Promise<number>): Promise<OutboxResult> {
    const maxWait = options.maxWaitMs ?? 5_000;
    const started = this.now();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const at = this.now();
      const t = this.slots.next(chatId);
      if (t - started > maxWait) break;
      this.slots.reserve(chatId, t);
      if (t > at) await this.sleep(t - at);
      try {
        let messageId: number;
        try {
          messageId = await send(false);
        } catch (error) {
          if (!isParseError(error)) throw error;
          messageId = await send(true);
        }
        this.count(options.kind, 'sent');
        return { outcome: 'sent', messageId };
      } catch (error) {
        if (error instanceof GrammyError && error.error_code === 429) {
          this.slots.block(chatId, Math.max(1, Number(error.parameters?.retry_after ?? 1)) * 1_000);
          this.count(options.kind, 'limited');
          continue;
        }
        if (error instanceof GrammyError && (error.error_code === 403 || (error.error_code === 400 && GONE.test(error.description)))) {
          this.count(options.kind, 'gone');
          return { outcome: 'gone' };
        }
        this.count(options.kind, 'failed');
        return { outcome: 'failed' };
      }
    }
    this.count(options.kind, 'dropped');
    return { outcome: 'dropped' };
  }
}
