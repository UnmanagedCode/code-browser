import { useState } from 'react';
import type { DialogInfo } from '../protocol';

interface Props {
  dialog: DialogInfo;
  hasControl: boolean;
  // The label of the tab the dialog came from (null when that tab is not listed) and whether it is the watched tab.
  tabLabel: string | null;
  // The tab's host (or scheme): the title is the page's own words, the host says where it came from.
  tabHost: string;
  shown: boolean;
  onShowTab(): void;
  onAnswer(action: 'accept' | 'dismiss', promptText?: string): void;
  onTake(): void;
}

// A JavaScript dialog the page opened. The message is page-controlled and rendered as text.
export function DialogPrompt({ dialog, hasControl, tabLabel, tabHost, shown, onShowTab, onAnswer, onTake }: Props) {
  const [text, setText] = useState(dialog.defaultPrompt);
  return (
    <div className="dialog-backdrop">
      <div role="dialog" aria-modal="true" aria-label="Page dialog" className="dialog">
        {tabLabel !== null && (
          <p className="dialog-source">
            From tab: <strong><bdi>{tabLabel}</bdi></strong>{tabHost && <> — <span className="dialog-host"><bdi>{tabHost}</bdi></span></>}
            {!shown && <> <button type="button" data-size="sm" onClick={onShowTab}>Show tab</button></>}
          </p>
        )}
        <p className="dialog-message">{dialog.message}</p>
        {dialog.dialogType === 'prompt' && (
          <input type="text" aria-label="Prompt answer" value={text} disabled={!hasControl} onChange={(e) => setText(e.target.value)} />
        )}
        {/* The backdrop covers the controller bar, so the dialog must offer taking control itself. */}
        {!hasControl && (
          <p className="hint">
            Take control to answer. <button type="button" data-size="sm" onClick={onTake}>Take control</button>
          </p>
        )}
        <div className="dialog-buttons">
          {dialog.dialogType !== 'alert' && (
            <button type="button" data-variant="ghost" disabled={!hasControl} onClick={() => onAnswer('dismiss')}>Cancel</button>
          )}
          <button type="button" data-variant="primary" disabled={!hasControl} onClick={() => onAnswer('accept', dialog.dialogType === 'prompt' ? text : undefined)}>OK</button>
        </div>
      </div>
    </div>
  );
}
