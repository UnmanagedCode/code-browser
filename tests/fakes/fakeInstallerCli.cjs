// Stands in for playwright-core's CLI (also CommonJS) in installer tests. Env: FAKE_INSTALL_ARGV (file to record
// argv into), FAKE_INSTALL_LINES (flood N lines), FAKE_INSTALL_EXIT (exit code), FAKE_INSTALL_HANG=1 (never exit).
const fs = require('node:fs');

if (process.env.FAKE_INSTALL_ARGV) {
  fs.writeFileSync(process.env.FAKE_INSTALL_ARGV, JSON.stringify({ args: process.argv.slice(2), script: process.argv[1] }));
}
process.stdout.write('downloading\r\n');
process.stderr.write('progress 50%\rprogress 100%\r\n');
const lines = Number(process.env.FAKE_INSTALL_LINES ?? 0);
for (let i = 1; i <= lines; i++) process.stdout.write(`line ${i}\n`);
process.stdout.write('done-marker\n');
if (process.env.FAKE_INSTALL_HANG === '1') setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.FAKE_INSTALL_EXIT ?? 0);
