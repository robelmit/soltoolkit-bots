/**
 * Where the links in a card and the buttons under it point. The defaults are
 * a neutral block explorer; a community sets its own templates, with
 * `{address}` and `{tx}` as placeholders. The kit carries no referral key and
 * favours no trading app.
 */

export interface LinkButton {
  readonly label: string;
  /** A URL template with `{address}` for the token. */
  readonly url: string;
}

export interface LinkTemplates {
  /** A token's page: `{address}`. */
  readonly token: string;
  /** A wallet's page: `{address}`. */
  readonly wallet: string;
  /** A transaction's page: `{tx}`. */
  readonly tx: string;
  /** The buttons under a token card and a buy post, in order. */
  readonly buttons: readonly LinkButton[];
  /** The short links printed in a row inside the card (`EXP · DS · X`), in order. */
  readonly row?: readonly LinkButton[];
  /** A token's holder map: `{address}`; null leaves the link out. */
  readonly holderMap?: string | null;
}

export const DEFAULT_LINKS: LinkTemplates = Object.freeze({
  token: 'https://solscan.io/token/{address}',
  wallet: 'https://solscan.io/account/{address}',
  tx: 'https://solscan.io/tx/{tx}',
  buttons: Object.freeze([Object.freeze({ label: 'Explorer', url: 'https://solscan.io/token/{address}' })]),
  row: Object.freeze([
    Object.freeze({ label: 'EXP', url: 'https://solscan.io/token/{address}' }),
    Object.freeze({ label: 'DS', url: 'https://dexscreener.com/solana/{address}' }),
    Object.freeze({ label: 'X', url: 'https://x.com/search?q={address}' }),
  ]),
  holderMap: 'https://soltoolkit-live.vercel.app/#/token/{address}',
});

const MAX_BUTTONS = 5;
const MAX_LABEL = 40;
const MAX_ROW = 10;
const MAX_ROW_LABEL = 12;

function httpsTemplate(value: string, what: string): string {
  let url: URL;
  try {
    url = new URL(value.replace(/\{(address|tx)\}/g, 'x'));
  } catch {
    throw new Error(`${what}: not a URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${what}: must start with https://`);
  return value;
}

/**
 * Button templates from one line of settings: `Label|https://…{address}`, several separated by commas or new lines.
 * Throws on anything that is not an https link with a label, so a typo stops the bot at start instead of posting a
 * broken button to every group.
 */
export function parseButtons(raw: string): LinkButton[] {
  return parseLinks(raw, 'button', MAX_BUTTONS, MAX_LABEL);
}

/** The card's row of short links from one line of settings (`LINK_ROW`): `CODE|https://…{address}`, at most ten. */
export function parseLinkRow(raw: string): LinkButton[] {
  return parseLinks(raw, 'link', MAX_ROW, MAX_ROW_LABEL);
}

function parseLinks(raw: string, what: string, max: number, maxLabel: number): LinkButton[] {
  const links: LinkButton[] = [];
  for (const part of raw.split(/[\n,]+/)) {
    const item = part.trim();
    if (!item) continue;
    const bar = item.indexOf('|');
    if (bar <= 0) throw new Error(`${what} "${item}": write it as Label|https://…`);
    const label = item.slice(0, bar).trim();
    const url = item.slice(bar + 1).trim();
    if (!label || label.length > maxLabel) throw new Error(`${what} "${item}": the label is 1 to ${maxLabel} characters`);
    links.push({ label, url: httpsTemplate(url, `${what} "${label}"`) });
  }
  if (links.length > max) throw new Error(`at most ${max} ${what}s`);
  return links;
}

/** The defaults with what a community set on top; every template is checked. */
export function linkTemplates(overrides: Partial<LinkTemplates> = {}): LinkTemplates {
  const merged = { ...DEFAULT_LINKS, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) } as LinkTemplates;
  httpsTemplate(merged.token, 'token link');
  httpsTemplate(merged.wallet, 'wallet link');
  httpsTemplate(merged.tx, 'transaction link');
  for (const button of merged.buttons) httpsTemplate(button.url, `button "${button.label}"`);
  for (const link of merged.row ?? []) httpsTemplate(link.url, `link "${link.label}"`);
  if (merged.holderMap) httpsTemplate(merged.holderMap, 'holder map link');
  return merged;
}

/**
 * The link settings every bot reads: `LINK_TOKEN`, `LINK_WALLET`, `LINK_TX`, `BOT_BUTTONS`, `LINK_ROW` and
 * `HOLDER_MAP_URL` (`off` leaves the holder map link out). A malformed one throws, naming it.
 */
export function linksFromSettings(get: (name: string) => string | undefined): LinkTemplates {
  const buttons = get('BOT_BUTTONS');
  const row = get('LINK_ROW');
  const holderMap = get('HOLDER_MAP_URL');
  return linkTemplates({
    token: get('LINK_TOKEN'),
    wallet: get('LINK_WALLET'),
    tx: get('LINK_TX'),
    ...(buttons !== undefined ? { buttons: parseButtons(buttons) } : {}),
    ...(row !== undefined ? { row: row.toLowerCase() === 'off' ? [] : parseLinkRow(row) } : {}),
    ...(holderMap !== undefined ? { holderMap: holderMap.toLowerCase() === 'off' ? null : holderMap } : {}),
  });
}

const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(address|tx)\}/g, (_, key: string) => encodeURIComponent(values[key] ?? ''));

export const tokenUrl = (links: LinkTemplates, address: string): string => fill(links.token, { address });
export const walletUrl = (links: LinkTemplates, address: string): string => fill(links.wallet, { address });
export const txUrl = (links: LinkTemplates, tx: string): string => fill(links.tx, { tx });

/** The buttons for one token, with their links filled in. */
export const buttonsFor = (links: LinkTemplates, address: string): LinkButton[] => links.buttons.map((button) => ({ label: button.label, url: fill(button.url, { address }) }));

/** The card's short links for one token, filled in. */
export const rowFor = (links: LinkTemplates, address: string): LinkButton[] => (links.row ?? []).map((link) => ({ label: link.label, url: fill(link.url, { address }) }));

export const holderMapUrl = (links: LinkTemplates, address: string): string | null => (links.holderMap ? fill(links.holderMap, { address }) : null);
