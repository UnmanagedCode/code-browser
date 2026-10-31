import { NAME_RE } from '../../src/limits.js';

// The panel routes by `?browser=<name>` only; cc's shell link `#plugin/<id>/?browser=<name>` lands here as that query.
export function browserFromSearch(search: string): string | null {
  const name = new URLSearchParams(search).get('browser');
  return name !== null && NAME_RE.test(name) ? name : null;
}

export function pushBrowser(name: string | null): void {
  history.pushState(null, '', name === null ? location.pathname : `?browser=${encodeURIComponent(name)}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
