import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(prefix = 'code-browser-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Raw request with full control of Host/Origin/Content-Type (fetch forbids some of them).
export function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const JSON_HEADERS = { 'content-type': 'application/json' };
