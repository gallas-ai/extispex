export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface StructuredLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Writes one JSON object per line to stdout, which container platforms collect as logs. */
export function createStructuredLogger(serviceName: string): StructuredLogger {
  const writeLogLine = (level: LogLevel, message: string, fields: LogFields = {}) => {
    const logLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: serviceName,
      message,
      ...serializeErrorFields(fields),
    });
    if (level === "error") {
      console.error(logLine);
    } else {
      console.log(logLine);
    }
  };
  return {
    debug: (message, fields) => writeLogLine("debug", message, fields),
    info: (message, fields) => writeLogLine("info", message, fields),
    warn: (message, fields) => writeLogLine("warn", message, fields),
    error: (message, fields) => writeLogLine("error", message, fields),
  };
}

function serializeErrorFields(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([fieldName, fieldValue]) => [
      fieldName,
      fieldValue instanceof Error
        ? { name: fieldValue.name, message: fieldValue.message, stack: fieldValue.stack }
        : fieldValue,
    ]),
  );
}
