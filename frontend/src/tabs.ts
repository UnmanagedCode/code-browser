import type { Tab } from './protocol';

// The single owner of how a tab is labelled, grouped, hidden and matched. Titles and URLs are page-controlled
// data: nothing here builds markup, a URL or a RegExp from them.

// Schemes of the browser's own pages, hidden from the tab list by default.
export const INTERNAL_SCHEMES = ['about:', 'chrome:', 'chrome-untrusted:', 'chrome-extension:', 'devtools:'];

const HOSTED = ['http:', 'https:', 'ws:', 'wss:', 'ftp:'];

function parse(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

// The host of a network URL, else its scheme ("chrome", "about", "file", "data"); '' when the URL does not parse.
export function tabHost(url: string): string {
  const u = parse(url);
  if (!u) return '';
  return HOSTED.includes(u.protocol) ? u.host : u.protocol.replace(/:$/, '');
}

export function isInternal(url: string): boolean {
  const u = parse(url);
  return u !== null && INTERNAL_SCHEMES.includes(u.protocol);
}

function safeDecode(s: string): string {
  try { return decodeURI(s); } catch { return s; }
}

// Chromium reports a URL-shaped placeholder (the URL without its scheme, or empty) until a page has a title.
export function isUrlTitle(title: string, url: string): boolean {
  if (title === '' || title === url) return true;
  const bare = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const forms = [bare, bare.replace(/\/$/, '')];
  return forms.some((f) => title === f || title === safeDecode(f));
}

// Bidirectional overrides, embeddings, isolates and marks: a page must not reorder the text around its own.
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
export const stripBidi = (text: string): string => text.replace(BIDI_CONTROLS, '');

export function tabLabel(tab: Tab): string {
  if (!isUrlTitle(tab.title, tab.url)) return stripBidi(tab.title);
  if (tab.url === '' || tab.url === 'about:blank') return 'Untitled';
  const u = parse(tab.url);
  if (u && (u.protocol === 'http:' || u.protocol === 'https:')) return (u.host + u.pathname + u.search).replace(/\/$/, '');
  return stripBidi(tab.url);
}

// Every whitespace-separated term must appear (case-insensitively, as plain text) in the tab's text. A word matches the
// label or the whole URL, so site names are searchable. A purely numeric term matches only the real title and the URL's
// path, query and fragment: it never matches the host or port, so `27` or `3000` does not select every loopback tab.
export function matchesQuery(tab: Tab, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const words = `${tabLabel(tab)} ${tab.url}`.toLowerCase();
  const u = parse(tab.url);
  const numbers = `${isUrlTitle(tab.title, tab.url) ? '' : tab.title} ${u && HOSTED.includes(u.protocol) ? u.pathname + u.search + u.hash : tab.url}`.toLowerCase();
  return terms.every((t) => (/^\d+$/.test(t) ? numbers : words).includes(t));
}

// `number` counts real windows from 1; the group of tabs whose window is unknown has none.
interface WindowGroup { windowId: number | null; number: number | null; tabs: Tab[] }

// Tabs by window, windows in order of their first tab and numbered from 1; tabs of unknown window form one
// unnumbered group, last.
export function windowGroups(tabs: Tab[]): WindowGroup[] {
  const groups: WindowGroup[] = [];
  for (const t of tabs) {
    let g = groups.find((x) => x.windowId === t.windowId);
    if (!g) { g = { windowId: t.windowId, number: null, tabs: [] }; groups.push(g); }
    g.tabs.push(t);
  }
  const real = groups.filter((g) => g.windowId !== null);
  real.forEach((g, i) => { g.number = i + 1; });
  return [...real, ...groups.filter((g) => g.windowId === null)];
}

// Most recently used first, then the tabs the backend has not seen used, in list order.
export function recentOrder(tabs: Tab[], recentTabIds: string[]): Tab[] {
  const byId = new Map(tabs.map((t) => [t.targetId, t]));
  const seen = new Set<string>();
  const first: Tab[] = [];
  for (const id of recentTabIds) {
    const t = byId.get(id);
    if (t && !seen.has(id)) { seen.add(id); first.push(t); }
  }
  return [...first, ...tabs.filter((t) => !seen.has(t.targetId))];
}

// The tabs shown in the strip and the switcher: browser pages are hidden unless asked for, but never the watched tab.
export function visibleTabs(tabs: Tab[], showInternal: boolean, activeTabId: string | null): Tab[] {
  return tabs.filter((t) => showInternal || !isInternal(t.url) || t.targetId === activeTabId);
}

// The muted second line of a switcher option: host and path of a network URL, else the whole URL.
export function tabDetail(url: string): string {
  const u = parse(url);
  return u && HOSTED.includes(u.protocol) ? tabHost(url) + u.pathname : url;
}
