import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { migrateLegacyStore } from '../src/migrateLegacyStore.js';
import { storeDir, tmpDir } from './helpers.mjs';

const SEED = ['profiles/a/Default/Preferences', 'settings/a.json', 'attached/b.json', 'proxy/secret.json', 'logs/a.log'];

function fixture() {
  const root = tmpDir();
  const legacy = path.join(root, '.code-browser');
  const target = storeDir(root);
  for (const f of SEED) {
    const file = path.join(legacy, f);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `content of ${f}`, { mode: 0o600 });
  }
  for (const d of ['', 'profiles', 'profiles/a', 'profiles/a/Default', 'settings', 'attached', 'proxy', 'logs']) fs.chmodSync(path.join(legacy, d), 0o700);
  const lines = [];
  const log = { log: (l) => lines.push(l) };
  const run = (opts = {}) => migrateLegacyStore({ env: { PROJECTS_ROOT: root }, dataDir: target, log, ...opts });
  return { root, legacy, target, lines, run };
}

// Every file and dir under `dir` as relative path -> mode and content, to compare trees.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      const mode = fs.statSync(p).mode & 0o777;
      if (e.isDirectory()) { out[rel] = { mode }; walk(p); } else out[rel] = { mode, data: fs.readFileSync(p, 'utf8') };
    }
  };
  walk(dir);
  return out;
}

// Invariant: with no legacy store the migration does nothing: it neither creates the target (boot does) nor logs.
test('no legacy dir: no-op', () => {
  const f = fixture();
  fs.rmSync(f.legacy, { recursive: true });
  f.run();
  assert.equal(fs.existsSync(f.target), false);
  assert.deepEqual(f.lines, []);
});

// Invariant: without PROJECTS_ROOT there is no legacy location to look in, so nothing happens.
test('PROJECTS_ROOT unset: no-op', () => {
  const f = fixture();
  const before = snapshot(f.legacy);
  f.run({ env: {} });
  f.run({ env: { PROJECTS_ROOT: '' } });
  assert.deepEqual(snapshot(f.legacy), before);
  assert.equal(fs.existsSync(f.target), false);
  assert.deepEqual(f.lines, []);
});

// Invariant: the legacy store moves to the data dir with every file byte-identical, and the move is logged once, naming both paths.
test('legacy dir present: moved, content intact, logged', () => {
  const f = fixture();
  f.run();
  for (const s of SEED) assert.equal(fs.readFileSync(path.join(f.target, s), 'utf8'), `content of ${s}`);
  assert.equal(fs.existsSync(f.legacy), false);
  assert.equal(f.lines.length, 1);
  assert.ok(f.lines[0].includes(f.legacy) && f.lines[0].includes(f.target));
});

// Invariant: the move keeps every mode exactly (rename, not a rewrite): a distinctive dir and file mode survive, as does the data dir's own.
test('modes are kept', () => {
  const f = fixture();
  fs.chmodSync(path.join(f.legacy, 'profiles', 'a'), 0o750);
  fs.chmodSync(path.join(f.legacy, 'settings', 'a.json'), 0o640);
  fs.chmodSync(f.legacy, 0o750);
  const before = snapshot(f.legacy);
  f.run();
  assert.deepEqual(snapshot(f.target), before);
  assert.equal(fs.statSync(path.join(f.target, 'profiles', 'a')).mode & 0o777, 0o750);
  assert.equal(fs.statSync(path.join(f.target, 'settings', 'a.json')).mode & 0o777, 0o640);
  assert.equal(fs.statSync(f.target).mode & 0o777, 0o750);
});

// Invariant: after a successful move a second run changes nothing and logs nothing.
test('re-run is a no-op', () => {
  const f = fixture();
  f.run();
  const before = snapshot(f.target);
  f.lines.length = 0;
  f.run();
  assert.deepEqual(snapshot(f.target), before);
  assert.deepEqual(f.lines, []);
});

// Invariant: an empty target dir does not block the move; the store lands at the target itself, not inside it.
test('empty target dir: moved into its place', () => {
  const f = fixture();
  fs.mkdirSync(f.target, { recursive: true });
  f.run();
  assert.equal(fs.readFileSync(path.join(f.target, 'proxy', 'secret.json'), 'utf8'), 'content of proxy/secret.json');
  assert.equal(fs.existsSync(f.legacy), false);
});

// Invariant: a non-empty target is refused with both paths named, and neither tree changes.
test('non-empty target: refused, nothing changed', () => {
  const f = fixture();
  fs.mkdirSync(f.target, { recursive: true });
  fs.writeFileSync(path.join(f.target, 'keep.txt'), 'mine');
  const [l, t] = [snapshot(f.legacy), snapshot(f.target)];
  assert.throws(() => f.run(), (e) => e.message.includes(f.legacy) && e.message.includes(f.target) && /not empty/.test(e.message));
  assert.deepEqual(snapshot(f.legacy), l);
  assert.deepEqual(snapshot(f.target), t);
  assert.deepEqual(f.lines, []);
});

// Invariant: across filesystems the move is refused with an mv instruction and the legacy store is untouched.
test('cross-device: refused, legacy untouched', () => {
  const f = fixture();
  const before = snapshot(f.legacy);
  const rename = () => { throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }); };
  assert.throws(() => f.run({ rename }), (e) => e.message.includes(`mv ${f.legacy} ${f.target}`));
  assert.deepEqual(snapshot(f.legacy), before);
  assert.deepEqual(f.lines, []);
});

// Invariant: a data dir that is the legacy path itself (standalone run) is left alone.
test('data dir is the legacy path: no-op', () => {
  const f = fixture();
  const before = snapshot(f.legacy);
  f.run({ dataDir: f.legacy });
  assert.deepEqual(snapshot(f.legacy), before);
  assert.deepEqual(f.lines, []);
});

// Invariant: a legacy path that is not a directory is refused, not moved.
test('legacy path is a file: refused', () => {
  const f = fixture();
  fs.rmSync(f.legacy, { recursive: true });
  fs.writeFileSync(f.legacy, 'x');
  assert.throws(() => f.run(), /is not a directory/);
  assert.equal(fs.readFileSync(f.legacy, 'utf8'), 'x');
  assert.equal(fs.existsSync(f.target), false);
});

// Invariant: an existing data dir that is not a directory (file, dangling symlink, symlink to a dir) is refused with a
// clear message naming both paths, and the legacy store is untouched.
test('data dir exists but is not a directory: refused', () => {
  const kinds = {
    file: (t) => fs.writeFileSync(t, 'x'),
    'dangling symlink': (t) => fs.symlinkSync(path.join(path.dirname(t), 'nowhere'), t),
    'symlink to an empty dir': (t) => { const d = path.join(path.dirname(t), 'real'); fs.mkdirSync(d); fs.symlinkSync(d, t); },
  };
  for (const [kind, make] of Object.entries(kinds)) {
    const f = fixture();
    fs.mkdirSync(path.dirname(f.target), { recursive: true });
    make(f.target);
    const before = snapshot(f.legacy);
    assert.throws(() => f.run(), (e) => e.message.includes(f.legacy) && e.message.includes(f.target) && /is not a directory/.test(e.message), kind);
    assert.deepEqual(snapshot(f.legacy), before, kind);
  }
});

// Invariant: a filesystem error (here ENOTDIR: the data dir's parent is a regular file) still names both paths.
test('other filesystem errors name both paths', () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(path.dirname(f.target)), { recursive: true });
  fs.writeFileSync(path.dirname(f.target), 'a file where plugins/data should be');
  const before = snapshot(f.legacy);
  assert.throws(() => f.run(), (e) => e.code === 'ENOTDIR' && e.message.includes(f.legacy) && e.message.includes(f.target));
  assert.deepEqual(snapshot(f.legacy), before);
});
