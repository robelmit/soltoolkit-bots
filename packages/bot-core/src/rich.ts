/**
 * A small rich-text model, so a card is written once and printed correctly on
 * both platforms. A line is a list of spans; each renderer escapes what its
 * platform treats as markup. Text from outside (a token's name, a symbol) can
 * therefore never break a message or smuggle in a link or a mention.
 */

export type Span = string | { readonly bold: string } | { readonly code: string } | { readonly link: string; readonly url: string };
export type Line = readonly Span[];

const MD_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escapes text for Telegram MarkdownV2 (outside code and link URLs). */
export const escapeMarkdownV2 = (text: string): string => text.replace(MD_SPECIAL, (c) => `\\${c}`);

function spanToMarkdownV2(span: Span): string {
  if (typeof span === 'string') return escapeMarkdownV2(span);
  if ('bold' in span) return `*${escapeMarkdownV2(span.bold)}*`;
  // Inside code only the backtick and the backslash are special; inside a link's URL only `)` and the backslash.
  if ('code' in span) return `\`${span.code.replace(/[`\\]/g, (c) => `\\${c}`)}\``;
  return `[${escapeMarkdownV2(span.link)}](${span.url.replace(/[)\\]/g, (c) => `\\${c}`)})`;
}

/** Lines as one Telegram MarkdownV2 message. */
export const toMarkdownV2 = (lines: readonly Line[]): string => lines.map((line) => line.map(spanToMarkdownV2).join('')).join('\n');

/** Escapes Discord markdown, and defuses mentions. */
export const escapeDiscord = (text: string): string => text.replace(/([\\*_~`|>[\]()#-])/g, '\\$1').replace(/@/g, '@\u200b');

function spanToDiscord(span: Span): string {
  if (typeof span === 'string') return escapeDiscord(span);
  if ('bold' in span) return `**${escapeDiscord(span.bold)}**`;
  if ('code' in span) return `\`${span.code.replace(/`/g, '')}\``;
  // Angle brackets keep Discord from unfurling the link under the message.
  return `[${escapeDiscord(span.link)}](<${span.url.replace(/[>\s]/g, '')}>)`;
}

/** Lines as Discord markdown (an embed's description, or a message). */
export const toDiscord = (lines: readonly Line[]): string => lines.map((line) => line.map(spanToDiscord).join('')).join('\n');

/** Lines as plain text: what is sent when a platform refuses the markup. */
export const toPlain = (lines: readonly Line[]): string =>
  lines.map((line) => line.map((span) => (typeof span === 'string' ? span : 'bold' in span ? span.bold : 'code' in span ? span.code : `${span.link} (${span.url})`)).join('')).join('\n');
