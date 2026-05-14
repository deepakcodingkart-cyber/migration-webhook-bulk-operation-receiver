import pino from "pino";
import os from "node:os";
import { PINO_TO_OTEL_SEVERITY } from "./utils/constant.mjs";

let lambdaContext = {};

const LEVEL_LABELS = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };
const getLevelLabel = (n) => LEVEL_LABELS[n] || "info";

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: {
    appId:    "bulk-migration-webhook",
    env:      process.env.NODE_ENV || "development",
    hostname: os.hostname(),
  },
  formatters: {
    level: (label) => ({ level: label }),
    log(object) {
      return {
        ...object,
        createdAt: new Date(object.time ?? Date.now()).toLocaleString("en-US", {
          year:   "numeric",
          month:  "short",
          day:    "2-digit",
          hour:   "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        }),
      };
    },
  },
  mixin(_ctx, level) {
    const label = getLevelLabel(level);
    return {
      severityNumber: PINO_TO_OTEL_SEVERITY[label] ?? 0,
      levelNumber:    level,
    };
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err:   pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
});

const setLambdaContext = (context) => {
  if (!context) return;
  lambdaContext = {
    lambdaName:         context.functionName,
    lambdaVersion:      context.functionVersion,
    awsRequestId:       context.awsRequestId,
    invokedFunctionArn: context.invokedFunctionArn,
    memoryLimitInMB:    context.memoryLimitInMB,
  };
};

const enrichPayload = (payload) => {
  if (typeof payload === "string") return { message: payload, ...lambdaContext };
  return { ...(payload || { message: "Log"}), ...lambdaContext };
};

// Accepts BOTH calling conventions:
//   pino-style:  logger.x({ ...payload }, "message")
//   legacy:      logger.x("message", { ...payload }, err?)
const normalizeArgs = (...args) => {
  // legacy: (message, payload?, err?)
  if (typeof args[0] === "string") {
    const [message, payload = {}, err] = args;
    const merged = err ? { ...payload, err } : payload;
    return [enrichPayload(merged), message];
  }
  // pino-style: (payload, message?)
  const [payload, message] = args;
  if (message !== undefined) return [enrichPayload(payload || {}), message];
  const enriched = enrichPayload(payload || {});
  const { message: msg, ...rest } = enriched;
  return [rest, msg || "Log"];
};

const wrap = (pinoInstance, inheritedBindings = {}) => ({
  trace: (...a) => pinoInstance.trace(...normalizeArgs(...a)),
  debug: (...a) => pinoInstance.debug(...normalizeArgs(...a)),
  info:  (...a) => pinoInstance.info(...normalizeArgs(...a)),
  warn:  (...a) => pinoInstance.warn(...normalizeArgs(...a)),
  error: (...a) => pinoInstance.error(...normalizeArgs(...a)),
  fatal: (...a) => pinoInstance.fatal(...normalizeArgs(...a)),
  child: (bindings) => {
    const merged = { ...inheritedBindings, ...bindings, ...lambdaContext };
    return wrap(pinoInstance.child(merged), merged);
  },
});

const root = wrap(pinoLogger);

export const logger = {
  setLambdaContext,
  ...root,
};
