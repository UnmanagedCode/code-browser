// Every tunable constant, in one place.
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_BROWSER_NAME = 'default';

export const DEFAULT_WINDOW = { width: 1280, height: 800 };

// Screencast
export const MAX_FPS = 15;
export const JPEG_QUALITY = 60;
export const MAX_FRAME_DIM = 1920;
export const VIEWER_HIGH_WATER = 512 * 1024;

// Control
export const CONTROL_LEASE_MS = 30_000;

// CDP and process lifecycle
export const CDP_TIMEOUT_MS = 10_000;
export const LAUNCH_TIMEOUT_MS = 15_000;
export const STOP_GRACE_MS = 5_000;
export const KILL_GRACE_MS = 1_500;
export const SHUTDOWN_GRACE_MS = 2_000;

// HTTP / WebSocket
export const MAX_BODY_BYTES = 64 * 1024;
export const WS_MAX_PAYLOAD = 64 * 1024;

// CDP client and launch polling
export const CDP_MAX_PAYLOAD = 64 * 1024 * 1024;
export const POLL_MS = 25;
export const LOG_TAIL_CHARS = 2000;
export const LOG_SCAN_CHARS = 256 * 1024;
