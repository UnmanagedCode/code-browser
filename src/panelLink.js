// cc's shell route into the panel: `#plugin/<id>/<subpath>` on cc's own page. The backend cannot know
// the address the user reaches cc at (proxy, tunnel, phone), so the path is host-relative.
export const panelPath = (name, pluginId = 'code-browser') => `/#plugin/${pluginId}/?browser=${encodeURIComponent(name)}`;
