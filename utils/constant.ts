// HTTP status codes used across the lambda + logging layer
export const statusCodes = {
  OK:           200,
  CREATED:      201,
  NO_CONTENT:   204,
  BAD_REQUEST:  400,
  UNAUTHORIZED: 401,
  FORBIDDEN:    403,
  NOT_FOUND:    404,
  CONFLICT:     409,
  SERVER_ERROR: 500,
} as const;

// Pino level → OpenTelemetry severityNumber mapping
// Used by logger mixin so logs interop with OTEL log pipelines
export const PINO_TO_OTEL_SEVERITY: Record<string, number> = {
  trace: 1,
  debug: 5,
  info:  9,
  warn:  13,
  error: 17,
  fatal: 21,
};
