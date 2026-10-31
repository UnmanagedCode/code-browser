// Panel <-> backend messages (docs/protocol.md → Panel WebSocket). Client messages carry `msg`, server messages `type`.
export interface BrowserSummary {
  name: string;
  status: 'running' | 'stopped';
  controller: 'agent' | 'human';
  sandbox: boolean | null;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
}

export interface Tab { targetId: string; url: string; title: string }

export type ControllerView = { kind: 'agent' } | { kind: 'human'; you: boolean };

export interface BrowserState {
  type: 'state';
  name: string;
  status: 'running' | 'stopped';
  sandbox?: boolean | null;
  controller?: ControllerView;
  tabs?: Tab[];
  activeTabId?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface DialogInfo { tabId: string; dialogType: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt: string }

export type ServerMessage =
  | { type: 'browsers'; list: BrowserSummary[] }
  | BrowserState
  | ({ type: 'dialog' } & DialogInfo)
  | { type: 'dialogClosed'; tabId: string }
  | { type: 'error'; code: string; message: string };

export type InputMessage =
  | { kind: 'mouse'; action: 'down' | 'up' | 'move'; x: number; y: number; button?: 'none' | 'left' | 'middle' | 'right'; buttons?: number; clickCount?: number; modifiers?: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | { kind: 'key'; action: 'down' | 'up'; key: string; code: string; keyCode: number; location: number; modifiers: number; autoRepeat: boolean; text?: string }
  | { kind: 'text'; text: string }
  | { kind: 'ime'; text: string; selectionStart: number; selectionEnd: number };

export type ClientMessage =
  | { msg: 'hello'; viewerId: string }
  | { msg: 'view'; name: string | null; maxWidth: number; maxHeight: number }
  | { msg: 'viewport'; maxWidth: number; maxHeight: number }
  | { msg: 'ack'; seq: number }
  | { msg: 'control'; action: 'take' | 'release' }
  | { msg: 'tab'; action: 'activate' | 'new' | 'close'; tabId?: string }
  | { msg: 'nav'; action: 'goto' | 'back' | 'forward' | 'reload'; url?: string }
  | ({ msg: 'input' } & InputMessage)
  | { msg: 'dialog'; tabId: string; action: 'accept' | 'dismiss'; promptText?: string };

export interface FrameMeta {
  deviceWidth: number; deviceHeight: number; offsetTop: number;
  pageScaleFactor: number; scrollOffsetX: number; scrollOffsetY: number;
}
export interface FrameHeader { seq: number; tabId: string; width: number; height: number; meta: FrameMeta }
