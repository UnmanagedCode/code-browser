import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// cc passes PORT and PROJECTS_ROOT to every plugin backend. Port 0 binds an ephemeral port.
export function loadConfig(env = process.env) {
  const root = env.PROJECTS_ROOT;
  if (!root) throw new Error('PROJECTS_ROOT is not set: it names the directory that holds .code-browser/');
  const port = env.PORT === undefined || env.PORT === '' ? 0 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT is not a valid port: ${env.PORT}`);
  return {
    port,
    pluginDir,
    pluginId: env.CONDUCTOR_PLUGIN_ID || 'code-browser',
    dataDir: path.join(path.resolve(root), '.code-browser'),
    distDir: path.join(pluginDir, 'frontend', 'dist'),
  };
}
