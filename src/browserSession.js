import { EventEmitter } from 'node:events';
import { createController } from './controller.js';
import { CodedError } from './errors.js';
import { inputToCdp, normalizeUrl } from './input.js';
import { MAX_PROMPT_TEXT } from './limits.js';
import { createScreencast } from './screencast.js';
import { emptyTabs, reduceTabs } from './tabs.js';

// Prerender and other subtyped targets are not tabs a person can see.
const isPage = (ti) => ti.type === 'page' && !ti.subtype;

// The live side of one running browser: tabs and the shared active tab, dialogs, navigation state,
// input dispatch, the controller lease and the screencast. Emits 'change' (any visible state),
// 'dialog' ({tabId, type, message, defaultPrompt}) and 'dialogClosed' ({tabId}).
//
// `attached`: the browser is a person's own (attached in the panel). Its existing tabs are seeded without
// becoming active, a tab is brought to the front only when someone starts watching it, and closing the last
// tab opens nothing.
export function createBrowserSession({ name, cdp, sandbox, attached = false, log = console, controllerOptions = {}, screencastOptions = {} }) {
  const events = new EventEmitter();
  const controller = createController({ ...controllerOptions, onChange: () => events.emit('change') });
  const warn = (what) => (err) => { if (!disposed) log.warn(`code-browser: '${name}' ${what}: ${err.message}`); };
  const screencast = createScreencast({
    send: (method, params, sessionId) => cdp.send(method, params, { sessionId }),
    onError: (err) => log.warn(`code-browser: '${name}' screencast: ${err.message}`),
    ...(attached ? { onStart: (tabId) => { cdp.send('Target.activateTarget', { targetId: tabId }).catch(warn('activateTarget')); } } : {}),
    ...screencastOptions,
  });
  let tabs = emptyTabs();
  let nav = { canGoBack: false, canGoForward: false };
  let disposed = false;
  let current = null; // the screencast target {sessionId, tabId}
  const sessionOfTab = new Map();
  const tabOfSession = new Map();
  const attaching = new Map(); // targetId -> promise of its page session id (null when the attach failed)
  const dialogs = new Map();

  // A listed tab may still be attaching: an action on it waits for its page session rather than failing.
  const callOn = async (tabId, method, params) => {
    const sessionId = sessionOfTab.get(tabId) ?? await attaching.get(tabId);
    if (!sessionId) throw new CodedError('NO_TAB', 'that tab is not attached');
    return cdp.send(method, params, { sessionId });
  };
  const activeSend = (method, params) => {
    if (!tabs.activeId) throw new CodedError('NO_TAB', 'there is no active tab');
    return callOn(tabs.activeId, method, params);
  };

  function syncScreencast() {
    const sessionId = tabs.activeId ? sessionOfTab.get(tabs.activeId) : undefined;
    if (current?.sessionId === sessionId && current?.tabId === tabs.activeId) return;
    current = sessionId ? { sessionId, tabId: tabs.activeId } : null;
    screencast.setTarget(sessionId ?? null, tabs.activeId);
  }

  async function refreshNav() {
    if (!tabs.activeId) return;
    const forTab = tabs.activeId;
    const { currentIndex, entries } = await activeSend('Page.getNavigationHistory', {});
    if (forTab !== tabs.activeId) return;
    const next = { canGoBack: currentIndex > 0, canGoForward: currentIndex < entries.length - 1 };
    if (next.canGoBack !== nav.canGoBack || next.canGoForward !== nav.canGoForward) {
      nav = next;
      events.emit('change');
    }
  }

  function apply(ev) {
    const before = tabs.activeId;
    tabs = reduceTabs(tabs, ev, controller.kind());
    if (tabs.activeId !== before) {
      syncScreencast();
      if (tabs.activeId) {
        if (!attached) cdp.send('Target.activateTarget', { targetId: tabs.activeId }).catch(warn('activateTarget'));
        refreshNav().catch(warn('navigation state'));
      }
    }
    events.emit('change');
  }

  function attach(targetId) {
    const done = (async () => {
      try {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        if (!tabs.tabs.some((t) => t.targetId === targetId)) return null; // closed while attaching
        sessionOfTab.set(targetId, sessionId);
        tabOfSession.set(sessionId, targetId);
        await cdp.send('Page.enable', {}, { sessionId });
        syncScreencast();
        if (targetId === tabs.activeId) refreshNav().catch(warn('navigation state'));
        return sessionId;
      } catch (err) {
        warn(`attach ${targetId}`)(err);
        return sessionOfTab.get(targetId) ?? null;
      } finally {
        attaching.delete(targetId);
      }
    })();
    attaching.set(targetId, done);
  }

  function forgetTab(targetId) {
    const sessionId = sessionOfTab.get(targetId);
    sessionOfTab.delete(targetId);
    if (sessionId) tabOfSession.delete(sessionId);
    if (dialogs.delete(targetId)) events.emit('dialogClosed', { tabId: targetId });
  }

  function onEvent({ method, params, sessionId }) {
    switch (method) {
      case 'Target.targetCreated':
        if (!isPage(params.targetInfo) || tabs.tabs.some((t) => t.targetId === params.targetInfo.targetId)) return;
        // The attach is registered before the tab is listed, so anything the listing triggers (the nav refresh of a
        // newly active tab) waits for it.
        attach(params.targetInfo.targetId);
        apply({ type: 'created', targetId: params.targetInfo.targetId, url: params.targetInfo.url, title: params.targetInfo.title });
        return;
      case 'Target.targetInfoChanged':
        if (isPage(params.targetInfo)) apply({ type: 'changed', targetId: params.targetInfo.targetId, url: params.targetInfo.url, title: params.targetInfo.title });
        return;
      case 'Target.targetDestroyed':
        if (!tabs.tabs.some((t) => t.targetId === params.targetId)) return;
        forgetTab(params.targetId);
        apply({ type: 'destroyed', targetId: params.targetId });
        if (tabs.tabs.length === 0 && !disposed && !attached) cdp.send('Target.createTarget', { url: 'about:blank' }).catch(warn('open blank tab'));
        return;
      case 'Page.screencastFrame':
        screencast.onFrame(sessionId, params);
        return;
      case 'Page.frameNavigated':
      case 'Page.navigatedWithinDocument':
        if (tabOfSession.get(sessionId) === tabs.activeId) refreshNav().catch(warn('navigation state'));
        return;
      case 'Page.javascriptDialogOpening': {
        const tabId = tabOfSession.get(sessionId);
        if (!tabId) return;
        const dialog = { tabId, type: params.type, message: params.message, defaultPrompt: params.defaultPrompt ?? '' };
        dialogs.set(tabId, dialog);
        events.emit('dialog', dialog);
        return;
      }
      case 'Page.javascriptDialogClosed': {
        const tabId = tabOfSession.get(sessionId);
        if (tabId && dialogs.delete(tabId)) events.emit('dialogClosed', { tabId });
        return;
      }
      default:
    }
  }

  const onEventBound = (ev) => onEvent(ev);

  return {
    name,
    events,
    controller,
    screencast,
    async start() {
      cdp.on('event', onEventBound);
      if (attached) {
        const { targetInfos } = await cdp.send('Target.getTargets');
        for (const ti of targetInfos.filter(isPage)) {
          attach(ti.targetId);
          apply({ type: 'created', background: true, targetId: ti.targetId, url: ti.url, title: ti.title });
        }
      }
      await cdp.send('Target.setDiscoverTargets', { discover: true });
    },
    dispose() {
      disposed = true;
      cdp.off('event', onEventBound);
    },
    snapshot: () => ({
      name,
      status: 'running',
      sandbox,
      tabs: tabs.tabs.map(({ targetId, url, title }) => ({ targetId, url, title })),
      activeTabId: tabs.activeId,
      ...nav,
    }),
    info: () => ({
      tabs: tabs.tabs.map((t) => ({ targetId: t.targetId, url: t.url, title: t.title, active: t.targetId === tabs.activeId })),
      activeTargetId: tabs.activeId,
    }),
    pendingDialogs: () => [...dialogs.values()],
    activateTab: (tabId) => apply({ type: 'activate', targetId: tabId }),
    async newTab() { await cdp.send('Target.createTarget', { url: 'about:blank' }); },
    async closeTab(tabId) {
      if (!tabs.tabs.some((t) => t.targetId === tabId)) throw new CodedError('NO_TAB', 'no such tab');
      await cdp.send('Target.closeTarget', { targetId: tabId });
    },
    async navigate(action, url) {
      switch (action) {
        case 'goto': await activeSend('Page.navigate', { url: normalizeUrl(url) }); return;
        case 'reload': await activeSend('Page.reload', {}); return;
        case 'back':
        case 'forward': {
          const { currentIndex, entries } = await activeSend('Page.getNavigationHistory', {});
          const entry = entries[currentIndex + (action === 'back' ? -1 : 1)];
          if (entry) await activeSend('Page.navigateToHistoryEntry', { entryId: entry.id });
          return;
        }
        default: throw new CodedError('INVALID_INPUT', 'unknown navigation action');
      }
    },
    input(msg) {
      const { method, params } = inputToCdp(msg);
      return activeSend(method, params);
    },
    async answerDialog(tabId, action, promptText) {
      if (!dialogs.has(tabId)) throw new CodedError('NO_DIALOG', 'no dialog is open on that tab');
      if (action !== 'accept' && action !== 'dismiss') throw new CodedError('INVALID_INPUT', 'dialog action must be accept or dismiss');
      if (promptText !== undefined && (typeof promptText !== 'string' || promptText.length > MAX_PROMPT_TEXT)) {
        throw new CodedError('INVALID_INPUT', `promptText must be a string of at most ${MAX_PROMPT_TEXT} characters`);
      }
      await callOn(tabId, 'Page.handleJavaScriptDialog', { accept: action === 'accept', ...(promptText === undefined ? {} : { promptText }) });
    },
  };
}
