import { describe, expect, it } from 'vitest';
import type { Tab } from './protocol';
import { INTERNAL_SCHEMES, isInternal, isUrlTitle, matchesQuery, recentOrder, tabHost, tabLabel, windowGroups } from './tabs';

const tab = (targetId: string, url = 'https://x.test/', title = '', windowId: number | null = 1): Tab => ({ targetId, url, title, windowId });

describe('tabLabel', () => {
  // Invariant: Chromium's URL-shaped placeholder titles never show as a label; host + path does.
  it('replaces placeholder titles with host and path', () => {
    expect(tabLabel(tab('a', 'http://127.0.0.1:46861/', '127.0.0.1:46861'))).toBe('127.0.0.1:46861');
    expect(tabLabel(tab('a', 'http://127.0.0.1:46861/n/path?q=1', '127.0.0.1:46861/n/path?q=1'))).toBe('127.0.0.1:46861/n/path?q=1');
    expect(tabLabel(tab('a', 'https://x.test/a/', 'https://x.test/a/'))).toBe('x.test/a');
    expect(tabLabel(tab('a', 'https://x.test/a%20b', 'x.test/a b'))).toBe('x.test/a%20b');
  });
  it('labels blank pages Untitled and keeps real titles', () => {
    expect(tabLabel(tab('a', 'about:blank', ''))).toBe('Untitled');
    expect(tabLabel(tab('a', '', ''))).toBe('Untitled');
    expect(tabLabel(tab('a', 'https://x.test/', 'Inbox'))).toBe('Inbox');
    expect(tabLabel(tab('a', 'chrome://version/', ''))).toBe('chrome://version/');
  });
  it('isUrlTitle survives malformed escapes', () => {
    expect(isUrlTitle('x.test/%E0%A4%A', 'https://x.test/%E0%A4%A')).toBe(true);
  });
});

describe('tabHost / isInternal', () => {
  it('gives the host for network URLs, the scheme otherwise, and empty when unparseable', () => {
    expect(tabHost('https://a.test:8080/x')).toBe('a.test:8080');
    for (const [url, host] of [['chrome://version/', 'chrome'], ['about:blank', 'about'], ['file:///etc/x', 'file'], ['data:text/html,hi', 'data']]) expect(tabHost(url)).toBe(host);
    expect(tabHost('not a url')).toBe('');
  });
  it('flags each internal scheme and not web pages', () => {
    for (const scheme of INTERNAL_SCHEMES) expect(isInternal(`${scheme}foo`)).toBe(true);
    expect(isInternal('https://x.test/')).toBe(false);
    expect(isInternal('')).toBe(false);
  });
});

describe('matchesQuery', () => {
  const t = tab('a', 'https://Docs.example.test/guide', 'Getting Started');
  it('needs every term, ignoring case, over label and URL', () => {
    expect(matchesQuery(t, 'started docs')).toBe(true);
    expect(matchesQuery(t, 'GUIDE')).toBe(true);
    expect(matchesQuery(t, 'started nope')).toBe(false);
    expect(matchesQuery(t, '   ')).toBe(true);
  });
  // Invariant: a number or word from the title or path finds the tab; digits of a host or port never select tabs.
  it('numeric terms skip the host and port; words still match the site', () => {
    const t27 = tab('a', 'http://127.0.0.1:3000/', 'tab-27');
    const other = tab('b', 'http://127.0.0.1:3000/', 'tab-03');
    const untitled = tab('c', 'http://localhost:3000/', '');
    expect(matchesQuery(t27, '27')).toBe(true);
    expect(matchesQuery(other, '27')).toBe(false);
    expect(matchesQuery(untitled, '3000')).toBe(false);
    expect(matchesQuery(untitled, '127')).toBe(false);
    expect(matchesQuery(tab('d', 'https://x.test/item/3000?p=27', 'Shop'), '3000 27')).toBe(true);
    expect(matchesQuery(untitled, 'localhost')).toBe(true);
    expect(matchesQuery(other, '127.0.0.1')).toBe(true);
  });
  it('takes regex metacharacters literally', () => {
    expect(matchesQuery(t, '.*')).toBe(false);
    expect(matchesQuery(tab('b', 'https://x.test/?a=1', 'a+b (c)'), 'a+b (c)')).toBe(true);
    expect(matchesQuery(t, '(')).toBe(false);
  });
});

describe('windowGroups / recentOrder', () => {
  // Invariant: only real windows are numbered, so an unknown-window group never takes or shifts a window number.
  it('numbers real windows by first appearance; unknown-window tabs form one unnumbered group, last', () => {
    const g = windowGroups([tab('d', '', '', null), tab('a', '', '', 5), tab('b', '', '', 2), tab('c', '', '', 5), tab('e', '', '', null)]);
    expect(g.map((x) => [x.windowId, x.number, x.tabs.map((t) => t.targetId)])).toEqual([[5, 1, ['a', 'c']], [2, 2, ['b']], [null, null, ['d', 'e']]]);
  });
  it('puts recent ids first, then the rest in list order, ignoring unknown ids', () => {
    const tabs = [tab('a'), tab('b'), tab('c')];
    expect(recentOrder(tabs, ['c', 'zzz', 'a']).map((t) => t.targetId)).toEqual(['c', 'a', 'b']);
    expect(recentOrder(tabs, []).map((t) => t.targetId)).toEqual(['a', 'b', 'c']);
  });
});

describe('stripBidi', () => {
  // Invariant: a label never carries directional controls.
  it('removes overrides, embeddings, isolates and marks from labels', () => {
    expect(tabLabel(tab('a', 'https://x.test/', 'a\u202Eb\u2066c\u200Fd'))).toBe('abcd');
  });
});
