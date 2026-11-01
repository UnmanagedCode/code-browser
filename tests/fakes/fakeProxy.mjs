// An in-process stand-in for proxy/cdp_proxy.py, so the default `npm test` covers the proxied path without Python.
// It speaks the real wire protocol (proxy/protocol.json) with its own HMAC code, publishes host.json in <dataDir>/proxy/,
// and pipes an authenticated connection to 127.0.0.1:<port>. `mode: 'blackhole'` accepts and never says hello.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PROTOCOL } from '../../src/proxyProtocol.js';

const { frames: F, macLabels: L, rendezvous: R } = PROTOCOL;
const hmac = (secret, label, np, nc, port) => crypto.createHmac('sha256', secret).update([label, np, nc, String(port)].join('\n')).digest('hex');
const line = (obj) => `${JSON.stringify(obj)}\n`;

export async function fakeProxy(dataDir, { mode = 'pipe' } = {}) {
  const dir = path.join(dataDir, R.dir);
  const sockets = new Set();
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); };
  const server = net.createServer((client) => {
    track(client);
    if (mode === 'blackhole') { client.resume(); return; }
    const nonce = crypto.randomBytes(PROTOCOL.nonceBytes).toString('base64url');
    client.write(line({ t: F.hello, v: PROTOCOL.protocolVersion, nonce }));
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf(10);
      if (i < 0) return;
      client.off('data', onData);
      client.pause();
      const auth = JSON.parse(buf.subarray(0, i).toString());
      const rest = buf.subarray(i + 1);
      const secret = JSON.parse(fs.readFileSync(path.join(dir, R.backendFile), 'utf8')).secret;
      if (auth.mac !== hmac(secret, L.client, nonce, auth.nonce, auth.port)) {
        client.end(line({ t: F.error, code: PROTOCOL.errorCodes.authFailed, message: 'authentication failed' }));
        return;
      }
      const up = net.connect(auth.port, '127.0.0.1', () => {
        client.write(line({ t: F.welcome, mac: hmac(secret, L.proxy, nonce, auth.nonce, auth.port) }));
        if (rest.length) up.write(rest);
        client.pipe(up);
        up.pipe(client);
        client.resume();
      });
      track(up);
      up.on('close', () => client.destroy());
      client.on('close', () => up.destroy());
    };
    client.on('data', onData);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, R.proxyFile), JSON.stringify({ protocolVersion: PROTOCOL.protocolVersion, listen: `127.0.0.1:${port}`, pid: process.pid }));
  return {
    port,
    connections: () => sockets.size,
    close: () => { server.close(); for (const s of sockets) s.destroy(); },
  };
}
