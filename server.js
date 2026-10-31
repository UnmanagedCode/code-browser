// Entry: build state, wire each feature once, listen.
import { createApp } from './src/app.js';
import { createBrowserManager } from './src/browserManager.js';
import { loadConfig } from './src/config.js';
import { createMcp } from './src/mcp.js';

const config = loadConfig();
const manager = createBrowserManager({ dataDir: config.dataDir });
const mcp = createMcp({ manager, pluginDir: config.pluginDir, pluginId: config.pluginId });

await manager.boot();
const server = createApp({ manager, mcp, distDir: config.distDir });
server.listen(config.port, '127.0.0.1', () => {
  console.log(`code-browser listening on 127.0.0.1:${server.address().port} (data: ${config.dataDir})`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await manager.shutdown();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
