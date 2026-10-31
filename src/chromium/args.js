import { DEFAULT_WINDOW } from '../limits.js';

// Chromium prints one of these when it cannot start its sandbox (containers, restricted user namespaces).
export const SANDBOX_FAILURE_PATTERNS = [/No usable sandbox/i, /Running as root without --no-sandbox/i];

export const isSandboxFailure = (logText) => SANDBOX_FAILURE_PATTERNS.some((re) => re.test(logText));

// Deliberately absent: --remote-allow-origins (Chromium's refusal of CDP sockets that carry an Origin
// is what keeps web pages away from CDP) and any proxy or host-resolver rule (agents browse local apps).
export function buildArgs({ profileDir, sandbox = true, window = DEFAULT_WINDOW }) {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    `--window-size=${window.width},${window.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    ...(sandbox ? [] : ['--no-sandbox']),
    'about:blank',
  ];
}
