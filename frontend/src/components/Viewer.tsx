import { useRef, useState } from 'react';
import { useMediaQuery } from '../useMediaQuery';
import type { BrowserState, BrowserSummary, DialogInfo } from '../protocol';
import type { ViewerSocket } from '../socket';
import { ALLOW_HINT } from './BrowserList';
import { ControllerBar } from './ControllerBar';
import { DialogPrompt } from './DialogPrompt';
import { ArrowLeftIcon, ArrowRightIcon, ChevronLeftIcon, KeyboardIcon, RotateCwIcon, SquareIcon } from './icons';
import { SandboxNotice } from './SandboxNotice';
import { Screen } from './Screen';
import { TabStrip } from './TabStrip';
import { UrlBar } from './UrlBar';

interface Props {
  name: string;
  socket: ViewerSocket;
  state: BrowserState | null;
  dialogs: DialogInfo[];
  summary?: BrowserSummary;
  onError(message: string): void;
  onBack(): void;
  onStart(): void;
  onStop(): void;
  onConnect(): void;
}

export function Viewer({ name, socket, state, dialogs, summary, onError, onBack, onStart, onStop, onConnect }: Props) {
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const touch = useMediaQuery('(any-pointer: coarse)');
  const running = state?.status === 'running';
  const controller = state?.controller ?? { kind: 'agent' as const };
  const hasControl = controller.kind === 'human' && controller.you;
  const tabs = state?.tabs ?? [];
  const activeTab = tabs.find((t) => t.targetId === state?.activeTabId);
  // The screen is mounted only while the browser runs and a tab is selected.
  const showScreen = running && !(tabs.length > 0 && !state?.activeTabId);
  const stopLabel = summary?.kind === 'attached' ? 'Disconnect' : 'Stop';
  const dialog = dialogs.find((d) => d.tabId === state?.activeTabId) ?? dialogs[0];

  return (
    <div className="viewer">
      <div className="toolbar">
        <button type="button" data-variant="ghost" data-size="sm" onClick={onBack} aria-label="Back to browsers" data-tip="Back to browsers"><ChevronLeftIcon />Browsers</button>
        <strong className="viewer-name" data-tip={name}>{name}</strong>
        <button type="button" data-variant="ghost" data-size="icon-sm" aria-label="Go back" data-tip="Go back" disabled={!hasControl || !state?.canGoBack} onClick={() => socket.send({ msg: 'nav', action: 'back' })}><ArrowLeftIcon /></button>
        <button type="button" data-variant="ghost" data-size="icon-sm" aria-label="Go forward" data-tip="Go forward" disabled={!hasControl || !state?.canGoForward} onClick={() => socket.send({ msg: 'nav', action: 'forward' })}><ArrowRightIcon /></button>
        <button type="button" data-variant="ghost" data-size="icon-sm" aria-label="Reload" data-tip="Reload" disabled={!hasControl} onClick={() => socket.send({ msg: 'nav', action: 'reload' })}><RotateCwIcon /></button>
        <UrlBar url={activeTab?.url ?? ''} hasControl={hasControl} onGo={(url) => socket.send({ msg: 'nav', action: 'goto', url })} />
        {touch && showScreen && (
          <button
            type="button"
            data-variant="ghost"
            data-size="sm"
            aria-label="Keyboard"
            data-tip="Type into the page"
            aria-pressed={keyboardActive}
            disabled={!hasControl}
            // Keep focus on the sink until click, so a press toggles instead of blurring first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { if (keyboardActive) keyboardRef.current?.blur(); else keyboardRef.current?.focus(); }}
          ><KeyboardIcon />Keyboard</button>
        )}
        {summary && summary.status !== 'stopped' && (
          <button type="button" data-size="sm" data-tip={stopLabel} onClick={onStop}><SquareIcon />{stopLabel}</button>
        )}
      </div>
      {!running && summary?.kind === 'attached' && summary.status !== 'running' ? (
        <div className="stopped" role="status" data-status={summary.status}>
          {summary.status === 'connecting' ? (
            <>
              <p>Connecting…</p>
              <p className="hint">{ALLOW_HINT}</p>
            </>
          ) : (
            <>
              <p>This browser is disconnected.</p>
              {summary.attachError && <p className="hint" data-warn="true">{summary.attachError}</p>}
              <button type="button" data-variant="primary" onClick={onConnect}>Connect</button>
            </>
          )}
        </div>
      ) : !running && state?.status === 'stopped' && summary?.sandboxUnavailable ? (
        <SandboxNotice summary={summary} onError={onError} />
      ) : !running ? (
        <div className="stopped" role="status" data-status={state?.status ?? 'connecting'}>
          <p>{state?.status === 'stopped' ? 'This browser is stopped.' : 'Connecting…'}</p>
          {state?.status === 'stopped' && <button type="button" data-variant="primary" onClick={onStart}>Start</button>}
        </div>
      ) : (
        <>
          <TabStrip
            tabs={tabs}
            activeTabId={state?.activeTabId ?? null}
            hasControl={hasControl}
            onActivate={(tabId) => socket.send({ msg: 'tab', action: 'activate', tabId })}
            onClose={(tabId) => socket.send({ msg: 'tab', action: 'close', tabId })}
            onNew={() => socket.send({ msg: 'tab', action: 'new' })}
          />
          <ControllerBar
            controller={controller}
            onTake={() => socket.send({ msg: 'control', action: 'take' })}
            onRelease={() => socket.send({ msg: 'control', action: 'release' })}
          />
          {showScreen
            ? <Screen socket={socket} hasControl={hasControl} keyboardRef={keyboardRef} onKeyboardActive={setKeyboardActive} onTake={() => socket.send({ msg: 'control', action: 'take' })} />
            : <p className="stopped" role="status">Select a tab to watch it.</p>}
          {dialog && (
            <DialogPrompt
              key={dialog.tabId}
              dialog={dialog}
              hasControl={hasControl}
              onTake={() => socket.send({ msg: 'control', action: 'take' })}
              onAnswer={(action, promptText) => socket.send({ msg: 'dialog', tabId: dialog.tabId, action, ...(promptText === undefined ? {} : { promptText }) })}
            />
          )}
        </>
      )}
    </div>
  );
}
