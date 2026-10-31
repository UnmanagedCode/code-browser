// Failures that carry a stable code to REST, MCP and WebSocket callers alike.
export class CodedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
  }
}

const STATUS = {
  INVALID_NAME: 400,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  EXISTS: 409,
  NOT_RUNNING: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  FORBIDDEN: 403,
};

export const statusFor = (err) => STATUS[err?.code] ?? 500;
