// The cross-site rule for every request and WebSocket upgrade (docs/protocol.md → Request guard).
//
// cc's proxy replays the browser's Host and Origin unchanged, so the only proof of where a
// request came from is Origin↔Host, compared by host and port under Origin's scheme.
// A request with no Origin is a same-origin GET, a non-browser client, or cc's own
// server-side MCP call; it passes unless `requireOrigin` is set (WebSocket upgrades).
export function requestRefusal(headers, { requireOrigin = false } = {}) {
  const origin = headers.origin;
  let scheme = 'http:';
  let o = null;
  if (origin !== undefined) {
    try { o = new URL(origin); } catch { return 'Origin is not a URL'; }
    if ((o.protocol !== 'http:' && o.protocol !== 'https:') || o.origin !== origin) return 'Origin is not an http(s) origin';
    scheme = o.protocol;
  } else if (requireOrigin) {
    return 'no Origin';
  }
  const host = headers.host;
  if (!host) return 'no Host';
  let h;
  try { h = new URL(`${scheme}//${host}`); } catch { return 'Host is malformed'; }
  if (h.username || h.password || h.pathname !== '/' || h.search || h.hash) return 'Host is malformed';
  if (o && h.host !== o.host) return 'Origin does not match Host';
  return null;
}
