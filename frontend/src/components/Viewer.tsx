import { useState } from 'react';
import type { BrowserState, DialogInfo } from '../protocol';
import type { ViewerSocket } from '../socket';
import { ControllerBar } from './ControllerBar';
import { DialogPrompt } from './DialogPrompt';
import { Screen } from './Screen';
import { TabStrip } from './TabStrip';
import { UrlBar } from './UrlBar';

interface Props {
  name: string;
  socket: ViewerSocket;
  state: BrowserState | null;
  dialogs: DialogInfo[];
  onBack(): void;
  onStart(): void;
}

export function Viewer({ name, socket, state, dialogs, onBack, onStart }: Props) {
  const [keyboardRequest, setKeyboardRequest] = useState(0);
  const running = state?.status === 'running';
  const controller = state?.controller ?? { kind: 'agent' as const };
  const hasControl = controller.kind === 'human' && controller.you;
  const tabs = state?.tabs ?? [];
  const activeTab = tabs.find((t) => t.targetId === state?.activeTabId);
  const dialog = dialogs.find((d) => d.tabId === state?.activeTabId) ?? dialogs[0];

  return (
    <div className="viewer">
      <div className="toolbar">
        <button type="button" onClick={onBack} aria-label="Back to browsers">☰</button>
        <strong className="viewer-name">{name}</strong>
        <button type="button" aria-label="Go back" disabled={!hasControl || !state?.canGoBack} onClick={() => socket.send({ msg: 'nav', action: 'back' })}>←</button>
        <button type="button" aria-label="Go forward" disabled={!hasControl || !state?.canGoForward} onClick={() => socket.send({ msg: 'nav', action: 'forward' })}>→</button>
        <button type="button" aria-label="Reload" disabled={!hasControl} onClick={() => socket.send({ msg: 'nav', action: 'reload' })}>⟳</button>
        <UrlBar url={activeTab?.url ?? ''} hasControl={hasControl} onGo={(url) => socket.send({ msg: 'nav', action: 'goto', url })} />
        <button type="button" aria-label="Show keyboard" disabled={!hasControl} onClick={() => setKeyboardRequest((n) => n + 1)}>⌨</button>
      </div>
      {!running ? (
        <div className="stopped">
          <p>{state?.status === 'stopped' ? 'This browser is stopped.' : 'Connecting…'}</p>
          {state?.status === 'stopped' && <button type="button" onClick={onStart}>Start</button>}
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
          <Screen socket={socket} hasControl={hasControl} keyboardRequest={keyboardRequest} />
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
