import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { focusInPanel } from '../focus';
import { useMediaQuery } from '../useMediaQuery';
import type { BrowserState, BrowserSummary, DialogInfo } from '../protocol';
import type { ViewerSocket } from '../socket';
import { tabHost, tabLabel } from '../tabs';
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
  // The socket is down: the last frame stays, dimmed, and nothing can be driven.
  offline: boolean;
  // The person just arrived here: the heading takes focus, if the panel has it.
  focusHeading: boolean;
  onError(message: string): void;
  onBack(): void;
  onStart(): void;
  onStop(): void;
  onConnect(): void;
}

export function Viewer({ name, socket, state, dialogs, summary, offline, focusHeading, onError, onBack, onStart, onStop, onConnect }: Props) {
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const panelId = useId();
  const [keyboardActive, setKeyboardActive] = useState(false);
  const touch = useMediaQuery('(any-pointer: coarse)');
  const [switcherRequest, setSwitcherRequest] = useState(0);
  const running = state?.status === 'running';
  const controller = state?.controller ?? { kind: 'agent' as const };
  const hasControl = !offline && controller.kind === 'human' && controller.you;
  const tabs = state?.tabs ?? [];
  const activeTab = tabs.find((t) => t.targetId === state?.activeTabId);
  // The screen is mounted only while the browser runs and a tab is selected.
  const showScreen = running && !(tabs.length > 0 && !state?.activeTabId);
  const stopLabel = summary?.kind === 'attached' ? 'Disconnect' : 'Stop';
  const dialogTabIds = useMemo(() => new Set(dialogs.map((d) => d.tabId)), [dialogs]);
  const dialog = dialogs.find((d) => d.tabId === state?.activeTabId) ?? dialogs[0];
  const shownDialog = running ? dialog : undefined;
  const dialogTab = dialog ? tabs.find((t) => t.targetId === dialog.tabId) : undefined;

  useEffect(() => { if (focusHeading) focusInPanel(headingRef.current); }, [name, focusHeading]);

  return (
    <main className="viewer" aria-labelledby={headingId}>
      <header className="toolbar" inert={!!shownDialog}>
        <button type="button" data-variant="ghost" data-size="sm" onClick={onBack} aria-label="Back to browsers" data-tip="Back to browsers"><ChevronLeftIcon />Browsers</button>
        <h1 ref={headingRef} id={headingId} className="viewer-name" tabIndex={-1} data-tip={name}><span className="viewer-name-text">{name}</span></h1>
        <button type="button" data-variant="ghost" data-size="icon-sm" aria-label="Go back" data-tip="Go back" disabled={!hasControl || !state?.canGoBack} onClick={() => socket.send({ msg: 'nav', action: 'back' })}><ArrowLeftIcon /></button>
        <button type="button" data-variant="ghost" data-size="icon-sm" aria-label="Go forward" data-tip="Go forward" disabled={!hasControl || !state?.canGoForward} onClick={() => socket.send({ msg: 'nav', action: 'forward' })}><ArrowRightIcon /></button>
        <button type="button" data-variant="ghost" data-size="icon-sm" aria-label="Reload" data-tip="Reload" disabled={!hasControl} onClick={() => socket.send({ msg: 'nav', action: 'reload' })}><RotateCwIcon /></button>
        <div className="toolbar-end">
          <UrlBar url={activeTab?.url ?? ''} hasControl={hasControl} onGo={(url) => socket.send({ msg: 'nav', action: 'goto', url })} />
          {touch && showScreen && (
            <button
              type="button"
              className="keyboard-toggle"
              data-variant="ghost"
              data-size="sm"
              aria-label="Keyboard"
              data-tip="Type into the page"
              aria-pressed={keyboardActive}
              disabled={!hasControl}
              // Keep focus on the sink until click, so a press toggles instead of blurring first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { if (keyboardActive) keyboardRef.current?.blur(); else keyboardRef.current?.focus(); }}
            ><KeyboardIcon /><span className="button-label">Keyboard</span></button>
          )}
          {summary && summary.status !== 'stopped' && (
            <button type="button" data-size="sm" data-tip={stopLabel} onClick={onStop}><SquareIcon />{stopLabel}</button>
          )}
        </div>
      </header>
      <div className="viewer-body" inert={offline || !!shownDialog} data-offline={offline || undefined}>
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
              recentTabIds={state?.recentTabIds ?? []}
              dialogTabIds={dialogTabIds}
              switcherRequest={switcherRequest}
              panelId={panelId}
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
              ? <Screen panelId={panelId} labelled={!!activeTab} socket={socket} hasControl={hasControl} keyboardRef={keyboardRef} onKeyboardActive={setKeyboardActive} onTake={() => socket.send({ msg: 'control', action: 'take' })} />
              : (
                <div className="stopped" role="status">
                  <p>Select a tab to watch it.</p>
                  <button type="button" data-variant="primary" onClick={() => setSwitcherRequest((n) => n + 1)}>Find a tab…</button>
                </div>
              )}
          </>
        )}
      </div>
      {shownDialog && (
        <DialogPrompt
          key={shownDialog.tabId}
          dialog={shownDialog}
          hasControl={hasControl}
          returnFocus={headingRef}
          tabLabel={dialogTab ? tabLabel(dialogTab) : null}
          tabHost={dialogTab ? tabHost(dialogTab.url) : ''}
          shown={shownDialog.tabId === state?.activeTabId}
          onShowTab={() => socket.send({ msg: 'tab', action: 'activate', tabId: shownDialog.tabId })}
          onTake={() => socket.send({ msg: 'control', action: 'take' })}
          onAnswer={(action, promptText) => socket.send({ msg: 'dialog', tabId: shownDialog.tabId, action, ...(promptText === undefined ? {} : { promptText }) })}
        />
      )}
    </main>
  );
}
