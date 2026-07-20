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
        "accessToken",
        "account.accessToken",
        "account.idToken",
        "account.refreshToken",
        "apiKey",
        "authorization",
        "clientSecret",
        "cookie",
        "idToken",
        "password",
        "refreshToken",
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.apiKey",
        "req.body.clientSecret",
        "req.body.newPassword",
        "req.body.password",
        "req.body.refreshToken",
        "req.body.secret",
        "req.body.token",
        "secret",
        "token",
      ],
      censor: "[REDACTED]",
    },
  };

  return pino(options);
}
