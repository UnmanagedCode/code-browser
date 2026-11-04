import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { Tab } from '../protocol';
import { isInternal, matchesQuery, recentOrder, tabDetail, tabLabel, visibleTabs, windowGroups } from '../tabs';

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  recentTabIds: string[];
  dialogTabIds: Set<string>;
  showInternal: boolean;
  onShowInternal(show: boolean): void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onPick(id: string): void;
  onClose(restoreFocus: boolean): void;
}

export const SHARED_TIP = "Everyone watching sees this tab; the agent's next script starts on it";

type Mode = 'window' | 'recent';
const PAGE = 10;

// A searchable list of every tab, by window or by recent use. Page-controlled text is only ever rendered as React text,
// and element ids never derive from it.
export function TabSwitcher({ tabs, activeTabId, recentTabIds, dialogTabIds, showInternal, onShowInternal, triggerRef, onPick, onClose }: Props) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('window');
  const [highlight, setHighlight] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionEls = useRef<(HTMLLIElement | null)[]>([]);

  const visible = visibleTabs(tabs, showInternal, activeTabId);
  const groups = windowGroups(visible);
  const windowOf = new Map(groups.flatMap((g) => g.tabs.map((t) => [t.targetId, g.number] as const)));
  const matches = (t: Tab) => matchesQuery(t, query);
  const shownGroups = groups.map((g) => ({ ...g, tabs: g.tabs.filter(matches) })).filter((g) => g.tabs.length > 0);
  const grouped = mode === 'window' && groups.length > 1;
  const items = grouped ? shownGroups.flatMap((g) => g.tabs) : mode === 'recent' ? recentOrder(visible, recentTabIds).filter(matches) : visible.filter(matches);
  const hiddenInternal = tabs.filter((t) => isInternal(t.url) && t.targetId !== activeTabId).length;

  // Starts on the watched tab when it is listed; a new query goes back to the first result.
  const activeIndex = items.findIndex((t) => t.targetId === activeTabId);
  const hi = items.length === 0 ? -1 : Math.min(highlight ?? Math.max(activeIndex, 0), items.length - 1);
  const optionId = (i: number) => `${uid}-opt-${i}`;

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { if (hi >= 0) optionEls.current[hi]?.scrollIntoView({ block: 'nearest' }); }, [hi]);
  useEffect(() => {
    const onPointerDown = (e: Event) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !triggerRef.current?.contains(target)) onClose(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose, triggerRef]);

  const pick = (id: string) => { onPick(id); onClose(true); };
  const move = (to: number) => setHighlight(Math.max(0, Math.min(items.length - 1, to)));
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(hi + 1); break;
      case 'ArrowUp': e.preventDefault(); move(hi - 1); break;
      case 'PageDown': e.preventDefault(); move(hi + PAGE); break;
      case 'PageUp': e.preventDefault(); move(hi - PAGE); break;
      case 'Enter': e.preventDefault(); if (hi >= 0) pick(items[hi].targetId); break;
      case 'Escape': e.preventDefault(); onClose(true); break;
      default:
    }
  };

  const renderOption = (t: Tab, i: number) => {
    const label = tabLabel(t);
    return (
      <li
        key={t.targetId}
        id={optionId(i)}
        role="option"
        className="tab-option"
        aria-selected={i === hi}
        ref={(el) => { optionEls.current[i] = el; }}
        onMouseEnter={() => setHighlight(i)}
        onClick={() => pick(t.targetId)}
      >
        <span className="tab-option-label">{label}</span>
        {t.targetId === activeTabId && <span className="tab-badge" data-kind="shared" title={SHARED_TIP}>Shared</span>}
        {dialogTabIds.has(t.targetId) && <span className="tab-badge" data-kind="dialog">Dialog</span>}
        {mode === 'recent' && groups.length > 1 && <span className="tab-badge">{`Window ${windowOf.get(t.targetId)}`}</span>}
        <span className="tab-option-host" title={t.url}>{tabDetail(t.url)}</span>
      </li>
    );
  };

  let index = 0;
  return (
    <div className="tab-switcher" role="dialog" aria-label="Search tabs" ref={rootRef}>
      <p className="hint">Choosing a tab shows it to everyone watching, and the agent&apos;s next script starts on it.</p>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="Search tabs"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={`${uid}-list`}
        aria-activedescendant={hi >= 0 ? optionId(hi) : undefined}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
        onKeyDown={onKeyDown}
      />
      <div className="tab-switcher-options">
        <div role="radiogroup" aria-label="Sort tabs by">
          {(['window', 'recent'] as const).map((m) => (
            <label key={m}>
              <input type="radio" name={`${uid}-mode`} checked={mode === m} onChange={() => { setMode(m); setHighlight(null); }} />
              {m === 'window' ? 'Window' : 'Recent'}
            </label>
          ))}
        </div>
        <label>
          <input type="checkbox" checked={showInternal} onChange={(e) => onShowInternal(e.target.checked)} />
          {`Show browser pages (${hiddenInternal})`}
        </label>
      </div>
      <ul id={`${uid}-list`} role="listbox" aria-label="Tabs">
        {grouped
          ? shownGroups.map((g) => (
            <li key={g.number} role="group" aria-labelledby={`${uid}-grp-${g.number}`}>
              <span id={`${uid}-grp-${g.number}`} className="tab-switcher-heading">{`Window ${g.number} · ${g.tabs.length} tabs`}</span>
              <ul role="presentation">{g.tabs.map((t) => renderOption(t, index++))}</ul>
            </li>
          ))
          : items.map((t, i) => renderOption(t, i))}
      </ul>
      {items.length === 0 && <p className="hint" role="status">No tabs match</p>}
    </div>
  );
}
