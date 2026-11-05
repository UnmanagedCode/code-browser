import { useEffect, useRef, useState } from 'react';
import type { ToastContent } from '../errorText';

export const TOAST_MS = 8000;

interface Props { toast: ToastContent; onDismiss(): void }

// One transient error. It closes itself after TOAST_MS, except while the pointer or keyboard focus is on it;
// a new toast (a new `toast` object) restarts the timer. Text is rendered as React text only.
export function Toast({ toast, onDismiss }: Props) {
  const [held, setHeld] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (held) return undefined;
    const t = setTimeout(() => dismiss.current(), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast, held]);
  // A new toast starts unheld.
  useEffect(() => setHeld(false), [toast]);

  return (
    <div
      className="toast"
      role="alert"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div className="toast-body">
        <span>{toast.text}</span>
        {toast.code && <span className="toast-code">{toast.code}</span>}
      </div>
      <button type="button" data-variant="ghost" data-size="icon-sm" aria-label="Dismiss" data-tip="Dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}
