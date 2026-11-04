// Pure reducer for one browser's tab list and the shared "active tab".
// State: {tabs: [{targetId, url, title, windowId}], activeId, mru: [targetId, …] (most recent first)}.
// `windowId` is null until a `window` event sets it.
// Events: created (`background: true` adds the tab without activating it), changed, destroyed, activate,
// window ({targetId, windowId}), synced ({infos: [{targetId, url, title}]}: fresh titles of tabs whose url still
// matches; it never changes the url or the active tab).
// `controller` is 'agent' | 'human'.
export const emptyTabs = () => ({ tabs: [], activeId: null, mru: [] });

const activate = (state, id) => ({ ...state, activeId: id, mru: [id, ...state.mru.filter((m) => m !== id)] });

export function reduceTabs(state, ev, controller) {
  switch (ev.type) {
    case 'created':
      if (state.tabs.some((t) => t.targetId === ev.targetId)) return state;
      // A new page is shown (the agent opened a tab, or a click opened a popup); a person's existing tab is not.
      if (ev.background) return { ...state, tabs: [...state.tabs, { targetId: ev.targetId, url: ev.url, title: ev.title, windowId: null }] };
      return activate({ ...state, tabs: [...state.tabs, { targetId: ev.targetId, url: ev.url, title: ev.title, windowId: null }] }, ev.targetId);
    case 'changed': {
      const prev = state.tabs.find((t) => t.targetId === ev.targetId);
      if (!prev) return state;
      if (prev.url === ev.url && prev.title === ev.title) return state;
      // The window is kept: only a `window` event changes it.
      const tabs = state.tabs.map((t) => (t === prev ? { ...t, url: ev.url, title: ev.title } : t));
      const next = { ...state, tabs };
      // The agent navigating a background tab pulls the view to it; a human driving does not.
      return controller === 'agent' && ev.url !== prev.url && state.activeId !== ev.targetId ? activate(next, ev.targetId) : next;
    }
    case 'destroyed': {
      if (!state.tabs.some((t) => t.targetId === ev.targetId)) return state;
      const mru = state.mru.filter((m) => m !== ev.targetId);
      const next = { tabs: state.tabs.filter((t) => t.targetId !== ev.targetId), mru, activeId: state.activeId };
      return state.activeId === ev.targetId ? { ...next, activeId: mru[0] ?? null } : next;
    }
    case 'activate':
      return state.tabs.some((t) => t.targetId === ev.targetId) ? activate(state, ev.targetId) : state;
    case 'window': {
      const prev = state.tabs.find((t) => t.targetId === ev.targetId);
      if (!prev || prev.windowId === ev.windowId) return state;
      return { ...state, tabs: state.tabs.map((t) => (t === prev ? { ...t, windowId: ev.windowId } : t)) };
    }
    case 'synced': {
      const fresh = new Map(ev.infos.map((i) => [i.targetId, i]));
      let changed = false;
      const tabs = state.tabs.map((t) => {
        const i = fresh.get(t.targetId);
        if (!i || i.url !== t.url || i.title === t.title) return t;
        changed = true;
        return { ...t, title: i.title };
      });
      return changed ? { ...state, tabs } : state;
    }
    default:
      return state;
  }
}
