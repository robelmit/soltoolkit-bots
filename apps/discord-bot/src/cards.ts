/**
 * What the Discord bot posts: the same cards as the Telegram bot, as embeds
 * with link buttons. Text from outside (a token's name, a symbol) is escaped
 * by the shared renderer, and mentions are defused, so a token named
 * "@everyone" pings nobody.
 *
 * A token card also carries two buttons of the bot's own: Copy CA (answers
 * with the bare address, for a phone's long-press) and Refresh (redraws the
 * card in place). Their ids are `c:<address>` and `r:<address>`.
 */

import { buttonsFor, buyPostCard, isWhale, toDiscord, tokenCard, trendingCard, type BuyPost, type CardExtras, type Line, type LinkTemplates, type TokenView } from '@soltoolkit/bot-core';
import { ButtonStyle, ComponentType, type APIActionRowComponent, type APIButtonComponent, type APIEmbed } from 'discord.js';

/** Side-bar colours of the embeds. */
export const COLORS = Object.freeze({ card: 0x5865f2, up: 0x22c55e, down: 0xef4444, buy: 0x22c55e, whale: 0x0ea5e9, note: 0x64748b });

export interface Payload {
  readonly content?: string;
  readonly embeds?: APIEmbed[];
  readonly components?: APIActionRowComponent<APIButtonComponent>[];
  /** Nobody is ever pinged by the bot. */
  readonly allowedMentions: { readonly parse: [] };
}

const NO_MENTIONS = { parse: [] as [] };

/** The ids of the card's own buttons. */
export const COPY_PREFIX = 'c:';
export const REFRESH_PREFIX = 'r:';

/** The link buttons for one token as one row; none when the community set none. */
export function buttonRow(links: LinkTemplates, address: string): APIActionRowComponent<APIButtonComponent>[] {
  const buttons = buttonsFor(links, address).map((b): APIButtonComponent => ({ type: ComponentType.Button, style: ButtonStyle.Link, label: b.label.slice(0, 80), url: b.url }));
  return buttons.length ? [{ type: ComponentType.ActionRow, components: buttons }] : [];
}

/** Copy CA and Refresh, under a token card. */
export function actionRow(address: string): APIActionRowComponent<APIButtonComponent> {
  return {
    type: ComponentType.ActionRow,
    components: [
      { type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Copy CA', emoji: { name: '📋' }, custom_id: `${COPY_PREFIX}${address}` },
      { type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Refresh', emoji: { name: '♻️' }, custom_id: `${REFRESH_PREFIX}${address}` },
    ],
  };
}

const embed = (lines: readonly Line[], color: number): APIEmbed => ({ description: toDiscord(lines).slice(0, 4_000), color });

/** A short answer in words. */
export const note = (lines: readonly Line[]): Payload => ({ embeds: [embed(lines, COLORS.note)], allowedMentions: NO_MENTIONS });

/** Green when the price rose over the hour (or the five minutes when the hour is unknown), red when it fell. */
export function cardColor(token: TokenView): number {
  const change = token.h1?.priceChangePct ?? token.m5.priceChangePct;
  if (change === null || change === undefined || !Number.isFinite(change) || change === 0) return COLORS.card;
  return change > 0 ? COLORS.up : COLORS.down;
}

const httpsImage = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

export interface TokenPayloadOptions extends CardExtras {
  /** The operator's credit line, in the embed's footer. */
  readonly poweredBy?: string | null;
}

export function tokenPayload(token: TokenView, links: LinkTemplates, now: number, options: TokenPayloadOptions = {}): Payload {
  const card = embed(tokenCard(token, links, now, options), cardColor(token));
  const image = httpsImage(token.image);
  if (image) card.thumbnail = { url: image };
  if (options.poweredBy) card.footer = { text: options.poweredBy.slice(0, 120) };
  return { embeds: [card], components: [...buttonRow(links, token.address), actionRow(token.address)], allowedMentions: NO_MENTIONS };
}

export const trendingPayload = (tokens: readonly TokenView[], links: LinkTemplates): Payload => ({ embeds: [embed(trendingCard(tokens, links), COLORS.card)], allowedMentions: NO_MENTIONS });

export function buyPayload(post: BuyPost, links: LinkTemplates): Payload {
  const whale = post.buys.length === 1 && isWhale(post.buys[0]!.usd, post.config.minUsd);
  return { embeds: [embed(buyPostCard(post, links), whale ? COLORS.whale : COLORS.buy)], components: buttonRow(links, post.config.address), allowedMentions: NO_MENTIONS };
}
