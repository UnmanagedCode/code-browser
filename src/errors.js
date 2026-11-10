// Failures that carry a stable code to REST, MCP and WebSocket callers alike.
// `details` is an optional plain object of machine-readable extras (never a stack); it is an own property only when given.
export class CodedError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
    if (details !== undefined) {
      const proto = details === null || typeof details !== 'object' ? undefined : Object.getPrototypeOf(details);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('CodedError details must be a plain object');
      this.details = details;
    }
  }
}

// The message plus its details as readable text, for surfaces that show one string (REST `error`, WebSocket `message`).
export function describeError(err) {
  let out = err.message;
  if (!err.details) return out;
  for (const [key, value] of Object.entries(err.details)) {
    if (Array.isArray(value)) out += `\n${key}:${value.map((item) => `\n  ${item}`).join('')}`;
    else if (typeof value === 'string' && value.includes('\n')) out += `\n${key}:\n${value}`;
    else out += `\n${key}: ${value}`;
  }
  return out;
}

// The `details` field a REST/WebSocket error body adds, or nothing.
export const detailsOf = (err) => (err instanceof CodedError && err.details ? { details: err.details } : {});

const STATUS = {
  INVALID_NAME: 400,
  BAD_REQUEST: 400,
  BAD_ENDPOINT: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  EXISTS: 409,
  NOT_RUNNING: 409,
  SANDBOX_UNAVAILABLE: 409,
  ATTACHED: 409,
  INSTALL_RUNNING: 409,
  BROWSER_CONTROLLED: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  FORBIDDEN: 403,
  RELAY_FULL: 503,
};

export const statusFor = (err) => STATUS[err?.code] ?? 500;
