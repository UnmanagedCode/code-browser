import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Invariant: no package in the runtime dependency tree runs an install script, so installing the plugin
// never executes third-party code. Dev-only packages (marked `dev` in the lockfile) are out of scope.
test('runtime dependency tree has no install scripts', () => {
  const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const offenders = Object.entries(lock.packages)
    .filter(([key, pkg]) => key !== '' && !pkg.dev && pkg.hasInstallScript)
    .map(([key]) => key);
  assert.deepEqual(offenders, []);
});
