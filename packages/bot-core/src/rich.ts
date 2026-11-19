/**
 * A small rich-text model, so a card is written once and printed correctly on
 * both platforms. A line is a list of spans; each renderer escapes what its
 * platform treats as markup. Text from outside (a token's name, a symbol) can
 * therefore never break a message or smuggle in a link or a mention.
 */

export type Span =
  | string
  | { readonly bold: string }
  | { readonly code: string }
  | { readonly link: string; readonly url: string }
  /** A figure set apart from its label: a grey box on Discord, plain text on Telegram (where code would copy on tap). */
  | { readonly value: string }
  /** A moment: Discord shows it in the reader's own time zone, ticking ("3 minutes ago"); elsewhere it is the UTC time. */
  | { readonly time: number };
export type Line = readonly Span[];

const MD_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escapes text for Telegram MarkdownV2 (outside code and link URLs). */
export const escapeMarkdownV2 = (text: string): string => text.replace(MD_SPECIAL, (c) => `\\${c}`);

/** `14:05 UTC`, or the date as well when it is not today. */
export function utcTime(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  return new Date(now).toISOString().slice(0, 10) === d.toISOString().slice(0, 10) ? hm : `${d.toISOString().slice(0, 10)} ${hm}`;
}

function spanToMarkdownV2(span: Span): string {
  if (typeof span === 'string') return escapeMarkdownV2(span);
  if ('bold' in span) return `*${escapeMarkdownV2(span.bold)}*`;
  if ('value' in span) return escapeMarkdownV2(span.value);
  if ('time' in span) return escapeMarkdownV2(utcTime(span.time));
  // Inside code only the backtick and the backslash are special; inside a link's URL only `)` and the backslash.
  if ('code' in span) return `\`${span.code.replace(/[`\\]/g, (c) => `\\${c}`)}\``;
  return `[${escapeMarkdownV2(span.link)}](${span.url.replace(/[)\\]/g, (c) => `\\${c}`)})`;
}

/** Lines as one Telegram MarkdownV2 message. */
export const toMarkdownV2 = (lines: readonly Line[]): string => lines.map((line) => line.map(spanToMarkdownV2).join('')).join('\n');

/** How many formatting entities the lines make on Telegram, which ignores those past 100 in one message. */
export const telegramEntities = (lines: readonly Line[]): number =>
  lines.reduce((n, line) => n + line.filter((span) => typeof span !== 'string' && ('bold' in span || 'code' in span || 'link' in span)).length, 0);

/** Escapes Discord markdown, and defuses mentions. */
export const escapeDiscord = (text: string): string => text.replace(/([\\*_~`|>[\]()#-])/g, '\\$1').replace(/@/g, '@\u200b');

function spanToDiscord(span: Span): string {
  if (typeof span === 'string') return escapeDiscord(span);
  if ('bold' in span) return `**${escapeDiscord(span.bold)}**`;
  if ('code' in span) return `\`${span.code.replace(/`/g, '')}\``;
  if ('value' in span) return `\`${span.value.replace(/`/g, '')}\``;
  if ('time' in span) return `<t:${Math.floor(span.time / 1000)}:R>`;
  // Angle brackets keep Discord from unfurling the link under the message.
  return `[${escapeDiscord(span.link)}](<${span.url.replace(/[>\s]/g, '')}>)`;
}

/** Lines as Discord markdown (an embed's description, or a message). */
export const toDiscord = (lines: readonly Line[]): string => lines.map((line) => line.map(spanToDiscord).join('')).join('\n');

const plainSpan = (span: Span): string =>
  typeof span === 'string' ? span : 'bold' in span ? span.bold : 'code' in span ? span.code : 'value' in span ? span.value : 'time' in span ? utcTime(span.time) : `${span.link} (${span.url})`;

/** Lines as plain text: what is sent when a platform refuses the markup. */
export const toPlain = (lines: readonly Line[]): string => lines.map((line) => line.map(plainSpan).join('')).join('\n');

/** Lines as plain text with links reduced to their words: for a terminal, a preview or a copy to paste. */
export const toText = (lines: readonly Line[]): string => lines.map((line) => line.map((span) => (typeof span !== 'string' && 'link' in span ? span.link : plainSpan(span))).join('')).join('\n');
