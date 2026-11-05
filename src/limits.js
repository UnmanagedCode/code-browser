// Every tunable constant, in one place.
export const NAME_RE = /^[a-z0-9][a-z0-9\-]{0,39}$/;
// The hyphen is escaped so the same source is also valid as an HTML `pattern`, which Chrome compiles with the v flag.
export const DEFAULT_BROWSER_NAME = 'default';

export const DEFAULT_WINDOW = { width: 1280, height: 800 };

// Screencast
export const MAX_FPS = 15;
export const JPEG_QUALITY = 60;
export const MAX_FRAME_DIM = 1920;
export const VIEWER_HIGH_WATER = 512 * 1024;

// A launched page's width is DEFAULT_WINDOW.width; its height follows the shape of the largest viewer's panel,
// clamped to this range and applied after the panel has stopped changing for VIEWPORT_DEBOUNCE_MS.
export const VIEWPORT_DEBOUNCE_MS = 500;
export const VIEWPORT_MIN_HEIGHT = 480;
export const VIEWPORT_MAX_HEIGHT = MAX_FRAME_DIM;

// Tabs: how often a running session re-reads tab titles (Chromium sends no event for a title commit)
export const TAB_SWEEP_MS = 1000;

// Control
export const CONTROL_LEASE_MS = 30_000;

// CDP and process lifecycle
export const CDP_TIMEOUT_MS = 10_000;
export const LAUNCH_TIMEOUT_MS = 15_000;
export const STOP_GRACE_MS = 5_000;
export const KILL_GRACE_MS = 1_500;
export const SHUTDOWN_GRACE_MS = 2_000;

// Attached browsers: how long a connection waits for a person to click Allow in Chrome's
// "Allow remote debugging?" dialog, and the largest /json/version answer read
export const APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_DISCOVERY_BYTES = 64 * 1024;

// Longest promptText a viewer may answer a JavaScript prompt() dialog with
export const MAX_PROMPT_TEXT = 8192;

// HTTP / WebSocket
export const MAX_BODY_BYTES = 64 * 1024;
export const WS_MAX_PAYLOAD = 64 * 1024;

// CDP client and launch polling
export const CDP_MAX_PAYLOAD = 64 * 1024 * 1024;
export const POLL_MS = 25;
export const LOG_TAIL_CHARS = 2000;
export const LOG_SCAN_CHARS = 256 * 1024;
