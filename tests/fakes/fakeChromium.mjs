#!/usr/bin/env node
// A fake Chromium for tests: injected through CODE_BROWSER_CHROMIUM, launched by the real keeper.
// Parses --user-data-dir, serves a CDP subset on 127.0.0.1:0 and writes DevToolsActivePort.
// Test knobs (env): FAKE_CHROMIUM_REQUIRE_NO_SANDBOX, FAKE_CHROMIUM_NO_PORT, FAKE_CHROMIUM_IGNORE_CLOSE.
// Test-only CDP methods: Fake.crash.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const profile = flag('--user-data-dir');
if (!profile) { console.error('fake chromium: no --user-data-dir'); process.exit(2); }

if (process.env.FAKE_CHROMIUM_REQUIRE_NO_SANDBOX && !args.includes('--no-sandbox')) {
  console.error('[1:1:0101/000000.000000:FATAL:zygote_host_impl_linux.cc(130)] No usable sandbox! (fake)');
  process.exit(134);
}

fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'fake-argv.json'), JSON.stringify(args));
fs.writeFileSync(path.join(profile, 'fake-pid'), String(process.pid));
for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
  if (fs.lstatSync(path.join(profile, f), { throwIfNoEntry: false })) {
    console.error(`fake chromium: stale ${f} present`);
    fs.writeFileSync(path.join(profile, 'fake-saw-stale-singleton'), f);
  }
}

const wsPath = `/devtools/browser/${randomUUID()}`;
const server = http.createServer((req, res) => {
  if (req.url === '/json/version') { res.end(JSON.stringify({ Browser: 'FakeChrome/1' })); return; }
  res.statusCode = 404; res.end();
});
const wss = new WebSocketServer({ server, path: wsPath });

function handle(ws, msg) {
  const reply = (result = {}) => ws.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result }));
  switch (msg.method) {
    case 'Browser.close':
      reply();
      if (!process.env.FAKE_CHROMIUM_IGNORE_CLOSE) setTimeout(() => process.exit(0), 10);
      return;
    case 'Fake.crash':
      process.kill(process.pid, 'SIGSEGV');
      return;
    default:
      reply();
  }
}
wss.on('connection', (ws) => ws.on('message', (d) => handle(ws, JSON.parse(d.toString()))));

server.listen(0, '127.0.0.1', () => {
  if (process.env.FAKE_CHROMIUM_NO_PORT) return;
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${server.address().port}\n${wsPath}\n`);
});
