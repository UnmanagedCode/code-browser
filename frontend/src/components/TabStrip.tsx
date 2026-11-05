import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { focusInPanel } from '../focus';
import type { Tab } from '../protocol';
import { stripBidi, tabLabel, visibleTabs, windowGroups } from '../tabs';
import { DialogBadge, SharedBadge, TabSwitcher } from './TabSwitcher';

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  recentTabIds: string[];
  dialogTabIds: Set<string>;
  hasControl: boolean;
  // A change to a value above 0 opens the switcher.
  switcherRequest: number;
  // The id of the tabpanel the active tab controls.
  panelId: string;
  onActivate(id: string): void;
  onClose(id: string): void;
  onNew(): void;
}

// The tab strip and its searchable switcher. Tab titles and URLs are page-controlled: only ever rendered as React text.
export function TabStrip({ tabs, activeTabId, recentTabIds, dialogTabIds, hasControl, switcherRequest, panelId, onActivate, onClose, onNew }: Props) {
  const [showInternal, setShowInternal] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tabEls = useRef(new Map<string, HTMLButtonElement>());
  const barRef = useRef<HTMLDivElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const descId = useId();
  // The tab a Delete press closed: once it leaves the list, focus goes to the tab that took its place.
  const closing = useRef<{ id: string; index: number } | null>(null);

  const ordered = windowGroups(visibleTabs(tabs, showInternal, activeTabId)).flatMap((g) => g.tabs);
  const tabStop = ordered.some((t) => t.targetId === activeTabId) ? activeTabId : ordered[0]?.targetId;

  useEffect(() => {
    const c = closing.current;
    if (!c || ordered.some((t) => t.targetId === c.id)) return;
    closing.current = null;
    // Only while focus is still here (the removed tab drops it to the body): a later removal elsewhere must not pull focus.
    const active = document.activeElement;
    if (active && active !== document.body && !barRef.current?.contains(active)) return;
    const next = ordered[Math.min(c.index, ordered.length - 1)];
    focusInPanel(next ? tabEls.current.get(next.targetId) : newRef.current);
  });
  useEffect(() => { if (switcherRequest > 0) setOpen(true); }, [switcherRequest]);
  useEffect(() => {
    if (activeTabId) tabEls.current.get(activeTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  const closeSwitcher = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  // Arrows move focus only: activating a tab changes the shared view and the agent's tab.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLButtonElement>('button[role="tab"]');
    const index = ordered.findIndex((t) => tabEls.current.get(t.targetId) === el);
    if (!el || index < 0) return;
    const focusAt = (i: number) => { e.preventDefault(); tabEls.current.get(ordered[(i + ordered.length) % ordered.length].targetId)?.focus(); };
    switch (e.key) {
      case 'ArrowRight': focusAt(index + 1); break;
      case 'ArrowLeft': focusAt(index - 1); break;
      case 'Home': focusAt(0); break;
      case 'End': focusAt(ordered.length - 1); break;
      case 'Enter':
      case ' ': e.preventDefault(); onActivate(ordered[index].targetId); break;
      case 'Delete': if (hasControl) { e.preventDefault(); closing.current = { id: ordered[index].targetId, index }; onClose(ordered[index].targetId); } break;
      default:
    }
  };

  return (
    <div className="tab-bar" ref={barRef}>
      <button type="button" ref={triggerRef} className="tab-switcher-trigger" data-size="sm" aria-label={`Search ${tabs.length} tabs`} data-tip="Search tabs" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {`${tabs.length} tabs…`}
      </button>
      <span id={descId} hidden>{hasControl ? 'Press Delete to close this tab.' : 'Take control to close this tab with Delete.'}</span>
      <div className="tab-strip" role="tablist" aria-label="Browser tabs" onKeyDown={onKeyDown}>
        {ordered.map((t) => {
          const label = tabLabel(t);
          const active = t.targetId === activeTabId;
          return (
            <span key={t.targetId} className="tab" role="presentation" data-active={active}>
              <button
                type="button"
                role="tab"
                ref={(el) => { if (el) tabEls.current.set(t.targetId, el); else tabEls.current.delete(t.targetId); }}
                id={active ? `${panelId}-tab` : undefined}
                aria-controls={active ? panelId : undefined}
                aria-selected={active}
                aria-keyshortcuts="Delete"
                aria-describedby={descId}
                tabIndex={t.targetId === tabStop ? 0 : -1}
                data-tip={stripBidi(`${label} · ${t.url}`)}
                onClick={() => onActivate(t.targetId)}
              >
                <span className="tab-label"><bdi>{label}</bdi></span>
                {dialogTabIds.has(t.targetId) && <DialogBadge />}
                {active && <SharedBadge />}
              </button>
              <button type="button" className="tab-close" data-variant="ghost" data-size="icon-sm" tabIndex={-1} aria-hidden="true" aria-label={`Close tab ${label}`} data-tip={`Close tab ${label} (Delete)`} disabled={!hasControl} onMouseDown={(e) => e.preventDefault()} onClick={() => onClose(t.targetId)}>×</button>
            </span>
          );
        })}
      </div>
      <button type="button" ref={newRef} className="tab-new" data-variant="ghost" data-size="icon-sm" aria-label="New tab" data-tip="New tab" disabled={!hasControl} onClick={onNew}>+</button>
      {open && (
        <TabSwitcher
          tabs={tabs}
          activeTabId={activeTabId}
          recentTabIds={recentTabIds}
          dialogTabIds={dialogTabIds}
          showInternal={showInternal}
          onShowInternal={setShowInternal}
          triggerRef={triggerRef}
          onPick={onActivate}
          onClose={closeSwitcher}
        />
      )}
    </div>
  );
}
