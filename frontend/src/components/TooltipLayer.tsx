import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const DELAY_MS = 300;
const MARGIN = 8;
const GAP = 6;

interface Tip { text: string; target: Element }

// One delegated tooltip for every element carrying `data-tip`. It is a fixed-position layer rather than
// CSS so that scroll containers (the tab strip) cannot clip it and it can be clamped to the viewport.
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => { clearTimeout(timer); setTip(null); };
    const show = (e: Event) => {
      const target = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      const text = target?.getAttribute('data-tip');
      clearTimeout(timer);
      if (!target || !text) { setTip(null); return; }
      timer = setTimeout(() => setTip({ text, target }), DELAY_MS);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('pointerover', show);
    document.addEventListener('focusin', show);
    document.addEventListener('pointerout', hide);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', hide, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', show);
      document.removeEventListener('focusin', show);
      document.removeEventListener('pointerout', hide);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', hide, true);
    };
  }, []);

  // Below the target, centred, clamped to the viewport; above when there is no room below.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) return;
    const t = tip.target.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(MARGIN, Math.min(t.left + t.width / 2 - w / 2, window.innerWidth - w - MARGIN));
    const below = t.bottom + GAP;
    const top = below + h + MARGIN > window.innerHeight ? Math.max(MARGIN, t.top - GAP - h) : below;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [tip]);

  return tip ? <div ref={ref} role="tooltip" className="tooltip">{tip.text}</div> : null;
}
