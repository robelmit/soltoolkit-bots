/**
 * What the Discord bot posts: the same cards as the Telegram bot, as embeds
 * with link buttons. Text from outside (a token's name, a symbol) is escaped
 * by the shared renderer, and mentions are defused, so a token named
 * "@everyone" pings nobody.
 */

import { buttonsFor, buyPostCard, isWhale, toDiscord, tokenCard, trendingCard, type BuyPost, type Line, type LinkTemplates, type TokenView } from '@soltoolkit/bot-core';
import { ButtonStyle, ComponentType, type APIActionRowComponent, type APIButtonComponent, type APIEmbed } from 'discord.js';

/** Side-bar colours of the embeds. */
export const COLORS = Object.freeze({ card: 0x5865f2, buy: 0x22c55e, whale: 0x0ea5e9, note: 0x64748b });

export interface Payload {
  readonly content?: string;
  readonly embeds?: APIEmbed[];
  readonly components?: APIActionRowComponent<APIButtonComponent>[];
  /** Nobody is ever pinged by the bot. */
  readonly allowedMentions: { readonly parse: [] };
}

const NO_MENTIONS = { parse: [] as [] };

/** The link buttons for one token as one row; none when the community set none. */
export function buttonRow(links: LinkTemplates, address: string): APIActionRowComponent<APIButtonComponent>[] {
  const buttons = buttonsFor(links, address).map((b): APIButtonComponent => ({ type: ComponentType.Button, style: ButtonStyle.Link, label: b.label.slice(0, 80), url: b.url }));
  return buttons.length ? [{ type: ComponentType.ActionRow, components: buttons }] : [];
}

const embed = (lines: readonly Line[], color: number): APIEmbed => ({ description: toDiscord(lines).slice(0, 4_000), color });

/** A short answer in words. */
export const note = (lines: readonly Line[]): Payload => ({ embeds: [embed(lines, COLORS.note)], allowedMentions: NO_MENTIONS });

export const tokenPayload = (token: TokenView, links: LinkTemplates, now: number): Payload => ({ embeds: [embed(tokenCard(token, links, now), COLORS.card)], components: buttonRow(links, token.address), allowedMentions: NO_MENTIONS });

export const trendingPayload = (tokens: readonly TokenView[], links: LinkTemplates): Payload => ({ embeds: [embed(trendingCard(tokens, links), COLORS.card)], allowedMentions: NO_MENTIONS });

export function buyPayload(post: BuyPost, links: LinkTemplates): Payload {
  const whale = post.buys.length === 1 && isWhale(post.buys[0]!.usd, post.config.minUsd);
  return { embeds: [embed(buyPostCard(post, links), whale ? COLORS.whale : COLORS.buy)], components: buttonRow(links, post.config.address), allowedMentions: NO_MENTIONS };
}
