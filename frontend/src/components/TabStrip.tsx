import type { Tab } from '../protocol';

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  hasControl: boolean;
  onActivate(id: string): void;
  onClose(id: string): void;
  onNew(): void;
}

// Tab titles are page-controlled: they are only ever rendered as React text.
export function TabStrip({ tabs, activeTabId, hasControl, onActivate, onClose, onNew }: Props) {
  return (
    <div className="tab-strip" role="tablist" aria-label="Browser tabs">
      {tabs.map((t) => {
        const label = t.title || t.url || 'New tab';
        return (
          <span key={t.targetId} className="tab" data-active={t.targetId === activeTabId}>
            <button type="button" role="tab" aria-selected={t.targetId === activeTabId} title={t.url} onClick={() => onActivate(t.targetId)}>
              {label}
            </button>
            <button type="button" className="tab-close" data-variant="ghost" data-size="icon-sm" aria-label={`Close tab ${label}`} data-tip={`Close tab ${label}`} disabled={!hasControl} onClick={() => onClose(t.targetId)}>×</button>
          </span>
        );
      })}
      <button type="button" className="tab-new" data-variant="ghost" data-size="icon-sm" aria-label="New tab" data-tip="New tab" disabled={!hasControl} onClick={onNew}>+</button>
    </div>
  );
}
