// Entry: build state, wire each feature once, listen. Order: config → migration → manager → mcp → installer → boot → relay token → listen.
import { createApp } from './src/app.js';
import { ensureArtifactsDir } from './src/artifacts.js';
import { createBrowserManager } from './src/browserManager.js';
import { createCdpRelay } from './src/cdpRelay.js';
import { createChromiumInstaller } from './src/chromium/install.js';
import { createSessionForEntry } from './src/browserSession.js';
import { loadConfig } from './src/config.js';
import { migrateLegacyStore } from './src/migrateLegacyStore.js';
import { createHelperInfo } from './src/helperInfo.js';
import { createMcp } from './src/mcp.js';
import { ensureRelayToken } from './src/relayToken.js';
import { createViewerGateway } from './src/viewerGateway.js';

const config = loadConfig();
// Must precede manager.boot(): boot creates the data dir and its secret, which would make the move's target non-empty.
migrateLegacyStore({ env: process.env, dataDir: config.dataDir });
const manager = createBrowserManager({
  dataDir: config.dataDir,
  createSession: (entry) => createSessionForEntry(entry),
});
let server;
const helperInfo = createHelperInfo({ pluginDir: config.pluginDir, dataDir: config.dataDir, port: () => server.address().port });
const mcp = createMcp({ manager, pluginDir: config.pluginDir, pluginId: config.pluginId, helperInfo });
const installer = createChromiumInstaller();

await manager.boot();
const relayToken = ensureRelayToken(config.dataDir);
ensureArtifactsDir(config.dataDir);
const gateway = createViewerGateway({ manager });
const relay = createCdpRelay({ manager, token: relayToken });
server = createApp({ manager, mcp, installer, distDir: config.distDir, dataDir: config.dataDir, token: relayToken, onUpgrade: gateway.handleUpgrade, onRelayUpgrade: relay.handleUpgrade });
server.listen(config.port, '127.0.0.1', () => {
  console.log(`code-browser listening on 127.0.0.1:${server.address().port} (data: ${config.dataDir})`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  gateway.close();
  relay.close();
  installer.close();
  await manager.shutdown();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
