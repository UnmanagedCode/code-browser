import { useEffect, useId, useRef } from 'react';

interface Props {
  label: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

// An in-place confirmation for a consequential action. Focus starts on Cancel, the safe default; Escape cancels.
export function InlineConfirm({ label, message, confirmLabel, destructive = false, onConfirm, onCancel }: Props) {
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return (
    <div
      className="inline-confirm"
      role="group"
      aria-label={label}
      aria-describedby={messageId}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
    >
      <p id={messageId}>{message}</p>
      <button type="button" data-variant={destructive ? 'destructive' : 'primary'} onClick={onConfirm}>{confirmLabel}</button>
      <button ref={cancelRef} type="button" data-variant="ghost" onClick={onCancel}>Cancel</button>
    </div>
  );
}
