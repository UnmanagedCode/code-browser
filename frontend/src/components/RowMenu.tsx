import { useEffect, useRef, useState, type Ref } from 'react';
import { EllipsisIcon } from './icons';

export interface RowMenuItem { label: string; onSelect(): void; tone?: 'destructive' }
interface Props { label: string; items: RowMenuItem[]; triggerRef?: Ref<HTMLButtonElement> }

// A "More actions" overflow menu: focus enters on the first item, arrows wrap, Escape/Tab close and return focus
// to the trigger, Tab closes it and moves on, and a press outside closes it. Choosing an item returns focus to the
// trigger first, so a row that survives keeps focus; a flow that follows (a confirmation, the attach form) then takes it.
export function RowMenu({ label, items, triggerRef }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => { if (open) itemRefs.current[0]?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const close = (refocus: boolean) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const move = (from: number, by: number) => itemRefs.current[(from + by + items.length) % items.length]?.focus();
  const setTrigger = (el: HTMLButtonElement | null) => {
    trigger.current = el;
    if (typeof triggerRef === 'function') triggerRef(el);
    else if (triggerRef) (triggerRef as { current: HTMLButtonElement | null }).current = el;
  };

  return (
    <div className="row-menu" ref={root}>
      <button
        ref={setTrigger}
        type="button"
        data-variant="ghost"
        data-size="icon-sm"
        aria-label={label}
        data-tip="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      ><EllipsisIcon /></button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            const i = itemRefs.current.findIndex((el) => el === document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); move(i, 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(i, -1); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
            else if (e.key === 'Tab') close(true);
          }}
        >
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              role="menuitem"
              data-tone={item.tone}
              onClick={() => { close(true); item.onSelect(); }}
            >{item.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
