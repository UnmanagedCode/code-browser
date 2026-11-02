import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// cc passes PORT and CONDUCTOR_PLUGIN_DATA_DIR to every plugin backend; cc never creates the data dir:
// `manager.boot()` does (ensurePrivateDir). Port 0 binds an ephemeral port.
export function loadConfig(env = process.env) {
  const dataDir = env.CONDUCTOR_PLUGIN_DATA_DIR;
  if (!dataDir) throw new Error("CONDUCTOR_PLUGIN_DATA_DIR is not set: it names code-browser's data directory");
  const port = env.PORT === undefined || env.PORT === '' ? 0 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT is not a valid port: ${env.PORT}`);
  return {
    port,
    pluginDir,
    pluginId: env.CONDUCTOR_PLUGIN_ID || 'code-browser',
    dataDir: path.resolve(dataDir),
    distDir: path.join(pluginDir, 'frontend', 'dist'),
  };
}
