import fs from 'node:fs/promises';
import path from 'node:path';
import { CodedError } from './errors.js';
import { MAX_BODY_BYTES } from './limits.js';

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

// The path of a request target, or null when the target is not a valid URL (`//[`, `http://[` reach us from raw clients).
export function parsePathname(target) {
  try { return new URL(target, 'http://localhost').pathname; } catch { return null; }
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.headersSent) return res.end();
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(text);
}

export function sendJson(res, status, value) {
  sendText(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

const JSON_TYPE = /^application\/json\s*(;|$)/i;

export function requireJson(req) {
  if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) {
    throw new CodedError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
}

// An empty body reads as {}.
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new CodedError('PAYLOAD_TOO_LARGE', 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new CodedError('BAD_REQUEST', 'body is not valid JSON')); }
    });
  });
}

// Only the built shell and its hashed assets are ever served from dist.
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const SERVED_NAME = /^assets\/[A-Za-z0-9._-]+\.(js|css|svg|png|woff2)$/;

export async function serveStatic(res, distDir, urlPath) {
  const rel = urlPath === '/' || urlPath === '/index.html' ? 'index.html' : urlPath.replace(/^\//, '');
  if (rel !== 'index.html' && !SERVED_NAME.test(rel)) return sendText(res, 404, 'not found');
  let data;
  try {
    data = await fs.readFile(path.join(distDir, rel));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    if (rel === 'index.html') return sendText(res, 503, 'UI not built — run npm install');
    return sendText(res, 404, 'not found');
  }
  const type = rel === 'index.html' ? 'text/html; charset=utf-8' : TYPES[path.extname(rel)];
  sendText(res, 200, data, type);
}
