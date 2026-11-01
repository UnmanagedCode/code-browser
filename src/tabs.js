// Pure reducer for one browser's tab list and the shared "active tab".
// State: {tabs: [{targetId, url, title}], activeId, mru: [targetId, …] (most recent first)}.
// Events: created (`background: true` adds the tab without activating it), changed, destroyed, activate.
// `controller` is 'agent' | 'human'.
export const emptyTabs = () => ({ tabs: [], activeId: null, mru: [] });

const activate = (state, id) => ({ ...state, activeId: id, mru: [id, ...state.mru.filter((m) => m !== id)] });

export function reduceTabs(state, ev, controller) {
  switch (ev.type) {
    case 'created':
      if (state.tabs.some((t) => t.targetId === ev.targetId)) return state;
      // A new page is shown (the agent opened a tab, or a click opened a popup); a person's existing tab is not.
      if (ev.background) return { ...state, tabs: [...state.tabs, { targetId: ev.targetId, url: ev.url, title: ev.title }] };
      return activate({ ...state, tabs: [...state.tabs, { targetId: ev.targetId, url: ev.url, title: ev.title }] }, ev.targetId);
    case 'changed': {
      const prev = state.tabs.find((t) => t.targetId === ev.targetId);
      if (!prev) return state;
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
    default:
      return state;
  }
}
