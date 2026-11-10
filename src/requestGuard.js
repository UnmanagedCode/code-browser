// The cross-site rule for every request and WebSocket upgrade (docs/protocol.md → Request guard).
//
// cc's proxy replays the browser's Host and Origin unchanged, so the only proof of where a
// request came from is Origin↔Host, compared by host and port under Origin's scheme.
// A request with no Origin is a same-origin GET, a non-browser client, or cc's own
// server-side MCP call; it passes unless `requireOrigin` is set (WebSocket upgrades).
//
// `listenPort` is the backend's own port. A Host naming it is a direct connection (a proxy's Host
// carries the proxy's port), and Origin==Host proves nothing there: an attacker hostname rebound to
// 127.0.0.1 supplies both. So a direct connection must use a loopback name. Rebinding onto cc's own
// port is indistinguishable from visiting cc and is cc's gap.
const defaultPort = (protocol) => (protocol === 'https:' ? 443 : 80);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function requestRefusal(headers, { requireOrigin = false, listenPort } = {}) {
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
  if (listenPort) {
    const port = h.port === '' ? defaultPort(h.protocol) : Number(h.port);
    if (port === listenPort && !LOOPBACK_HOSTS.has(h.hostname)) return "Host names this backend's own port but is not a loopback name";
  }
  return null;
}

// The CDP relay's rule (docs/protocol.md → CDP relay). A relay client is a local program, never a page: any Origin
// is refused, as Chromium refuses one on its own CDP sockets. The Host must be a loopback name on this backend's
// own port, so the relay is direct-only: a request through a proxy (cc's included) carries the proxy's port.
export function relayRefusal(headers, { listenPort }) {
  if (headers.origin !== undefined) return 'the relay accepts no Origin';
  const host = headers.host;
  if (!host) return 'no Host';
  let h;
  try { h = new URL(`http://${host}`); } catch { return 'Host is malformed'; }
  if (h.username || h.password || h.pathname !== '/' || h.search || h.hash) return 'Host is malformed';
  if (!LOOPBACK_HOSTS.has(h.hostname)) return 'Host is not a loopback name';
  if (Number(h.port || 80) !== listenPort) return "Host does not name this backend's own port";
  return null;
}
