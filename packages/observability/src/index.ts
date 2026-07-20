import pino, { type Logger, type LoggerOptions } from "pino";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export interface LoggerConfiguration {
  level: LogLevel;
  service: string;
  environment: string;
}

export function createLogger(configuration: LoggerConfiguration): Logger {
  const options: LoggerOptions = {
    level: configuration.level,
    base: {
      service: configuration.service,
      environment: configuration.environment,
    },
    redact: {
      paths: [
        "authorization",
        "cookie",
        "password",
        "req.headers.authorization",
        "req.headers.cookie",
        "token",
      ],
      censor: "[REDACTED]",
    },
  };

  return pino(options);
}
