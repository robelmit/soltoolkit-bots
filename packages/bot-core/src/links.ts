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
}

export const DEFAULT_LINKS: LinkTemplates = Object.freeze({
  token: 'https://solscan.io/token/{address}',
  wallet: 'https://solscan.io/account/{address}',
  tx: 'https://solscan.io/tx/{tx}',
  buttons: Object.freeze([Object.freeze({ label: 'Explorer', url: 'https://solscan.io/token/{address}' })]),
});

const MAX_BUTTONS = 5;
const MAX_LABEL = 40;

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
  const buttons: LinkButton[] = [];
  for (const part of raw.split(/[\n,]+/)) {
    const item = part.trim();
    if (!item) continue;
    const bar = item.indexOf('|');
    if (bar <= 0) throw new Error(`button "${item}": write it as Label|https://…`);
    const label = item.slice(0, bar).trim();
    const url = item.slice(bar + 1).trim();
    if (!label || label.length > MAX_LABEL) throw new Error(`button "${item}": the label is 1 to ${MAX_LABEL} characters`);
    buttons.push({ label, url: httpsTemplate(url, `button "${label}"`) });
  }
  if (buttons.length > MAX_BUTTONS) throw new Error(`at most ${MAX_BUTTONS} buttons`);
  return buttons;
}

/** The defaults with what a community set on top; every template is checked. */
export function linkTemplates(overrides: Partial<LinkTemplates> = {}): LinkTemplates {
  const merged = { ...DEFAULT_LINKS, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) } as LinkTemplates;
  httpsTemplate(merged.token, 'token link');
  httpsTemplate(merged.wallet, 'wallet link');
  httpsTemplate(merged.tx, 'transaction link');
  for (const button of merged.buttons) httpsTemplate(button.url, `button "${button.label}"`);
  return merged;
}

const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(address|tx)\}/g, (_, key: string) => encodeURIComponent(values[key] ?? ''));

export const tokenUrl = (links: LinkTemplates, address: string): string => fill(links.token, { address });
export const walletUrl = (links: LinkTemplates, address: string): string => fill(links.wallet, { address });
export const txUrl = (links: LinkTemplates, tx: string): string => fill(links.tx, { tx });

/** The buttons for one token, with their links filled in. */
export const buttonsFor = (links: LinkTemplates, address: string): LinkButton[] => links.buttons.map((button) => ({ label: button.label, url: fill(button.url, { address }) }));
