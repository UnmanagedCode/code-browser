import { useState } from 'react';
import type { DialogInfo } from '../protocol';

interface Props { dialog: DialogInfo; hasControl: boolean; onAnswer(action: 'accept' | 'dismiss', promptText?: string): void; onTake(): void }

// A JavaScript dialog the page opened. The message is page-controlled and rendered as text.
export function DialogPrompt({ dialog, hasControl, onAnswer, onTake }: Props) {
  const [text, setText] = useState(dialog.defaultPrompt);
  return (
    <div className="dialog-backdrop">
      <div role="dialog" aria-modal="true" aria-label="Page dialog" className="dialog">
        <p className="dialog-message">{dialog.message}</p>
        {dialog.dialogType === 'prompt' && (
          <input type="text" aria-label="Prompt answer" value={text} disabled={!hasControl} onChange={(e) => setText(e.target.value)} />
        )}
        {/* The backdrop covers the controller bar, so the dialog must offer taking control itself. */}
        {!hasControl && (
          <p className="hint">
            Take control to answer. <button type="button" onClick={onTake}>Take control</button>
          </p>
        )}
        <div className="dialog-buttons">
          {dialog.dialogType !== 'alert' && (
            <button type="button" disabled={!hasControl} onClick={() => onAnswer('dismiss')}>Cancel</button>
          )}
          <button type="button" disabled={!hasControl} onClick={() => onAnswer('accept', dialog.dialogType === 'prompt' ? text : undefined)}>OK</button>
        </div>
      </div>
    </div>
  );
}
