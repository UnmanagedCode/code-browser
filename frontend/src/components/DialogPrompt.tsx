import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { focusInPanel } from '../focus';
import type { DialogInfo } from '../protocol';

interface Props {
  dialog: DialogInfo;
  hasControl: boolean;
  // The label of the tab the dialog came from (null when that tab is not listed) and whether it is the watched tab.
  tabLabel: string | null;
  // The tab's host (or scheme): the title is the page's own words, the host says where it came from.
  tabHost: string;
  shown: boolean;
  // Where focus goes when the dialog closes and the control that had it is gone.
  returnFocus: RefObject<HTMLElement | null>;
  onShowTab(): void;
  onAnswer(action: 'accept' | 'dismiss', promptText?: string): void;
  onTake(): void;
}

// A JavaScript dialog the page opened. The message is page-controlled and rendered as text.
// It is keyed by tab, so it mounts once per dialog: it takes focus then (only while the panel has it) and gives it back on unmount.
export function DialogPrompt({ dialog, hasControl, tabLabel, tabHost, shown, returnFocus, onShowTab, onAnswer, onTake }: Props) {
  const [text, setText] = useState(dialog.defaultPrompt);
  const messageId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const takeRef = useRef<HTMLButtonElement>(null);
  const hadControl = useRef(hasControl);
  const returnTo = useRef<Element | null>(null);

  const answerTarget = () => (dialog.dialogType === 'prompt' ? inputRef.current : okRef.current);

  useEffect(() => {
    returnTo.current = document.activeElement;
    focusInPanel(hasControl ? answerTarget() : takeRef.current);
    const fallback = returnFocus;
    return () => {
      const prev = returnTo.current;
      const usable = prev instanceof HTMLElement && prev.isConnected && !prev.closest('[inert]');
      focusInPanel(usable ? prev : fallback.current);
    };
    // Once per dialog: the component is keyed by tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Taking control unmounts the Take control button, which held focus: the person's own action, so focus moves directly.
  useEffect(() => {
    if (hasControl && !hadControl.current && document.activeElement === document.body) answerTarget()?.focus();
    hadControl.current = hasControl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasControl]);

  return (
    <div className="dialog-backdrop">
      <div role="dialog" aria-modal="true" aria-label="Page dialog" aria-describedby={messageId} className="dialog">
        {tabLabel !== null && (
          <p className="dialog-source">
            From tab: <strong><bdi>{tabLabel}</bdi></strong>{tabHost && <> — <span className="dialog-host"><bdi>{tabHost}</bdi></span></>}
            {!shown && <> <button type="button" data-size="sm" onClick={onShowTab}>Show tab</button></>}
          </p>
        )}
        <p id={messageId} className="dialog-message">{dialog.message}</p>
        {dialog.dialogType === 'prompt' && (
          <input ref={inputRef} type="text" aria-label="Prompt answer" value={text} disabled={!hasControl} onChange={(e) => setText(e.target.value)} />
        )}
        {/* The backdrop covers the controller bar, so the dialog must offer taking control itself. */}
        {!hasControl && (
          <p className="hint">
            Take control to answer. <button ref={takeRef} type="button" data-size="sm" onClick={onTake}>Take control</button>
          </p>
        )}
        <div className="dialog-buttons">
          {dialog.dialogType !== 'alert' && (
            <button type="button" data-variant="ghost" disabled={!hasControl} onClick={() => onAnswer('dismiss')}>Cancel</button>
          )}
          <button ref={okRef} type="button" data-variant="primary" disabled={!hasControl} onClick={() => onAnswer('accept', dialog.dialogType === 'prompt' ? text : undefined)}>OK</button>
        </div>
      </div>
    </div>
  );
}
