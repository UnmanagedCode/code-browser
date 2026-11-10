import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactsDirOf } from './artifacts.js';
import { relayUrl } from './cdpRelay.js';
import { relayTokenFile } from './relayToken.js';

// The run_code helper's file URL (a file URL so `await import()` works on every platform).
export const helperModuleUrl = (pluginDir) => pathToFileURL(path.join(pluginDir, 'src', 'runCode', 'index.js')).href;

// `helper` in browser_info/start_browser: where the run_code helper finds the relay, the artifacts route, the token
// file (never its value) and Playwright's artifacts dir. `port()` is the backend's listening port.
export function createHelperInfo({ pluginDir, dataDir, port }) {
  const module = helperModuleUrl(pluginDir);
  return (name) => ({
    module,
    relay: relayUrl(port(), name),
    artifacts: `http://127.0.0.1:${port()}/api/artifacts`,
    tokenFile: relayTokenFile(dataDir),
    artifactsDir: artifactsDirOf(dataDir),
  });
}
