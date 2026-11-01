import { readFileSync } from 'node:fs';

// The CDP proxy's wire protocol, read from its single source: proxy/protocol.json, which proxy/cdp_proxy.py
// reads too. Nothing on the backend side restates a value from it.
export const PROTOCOL = Object.freeze(JSON.parse(readFileSync(new URL('../proxy/protocol.json', import.meta.url), 'utf8')));
