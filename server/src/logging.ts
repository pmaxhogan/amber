import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import type { Config } from "./config.ts";

export type { Logger };

/**
 * pino only, never console.*. Two destinations: NDJSON on stdout for the
 * container log driver, and a size-rotated file in LOGS_DIR for the NAS.
 */
export function createLogger(config: Pick<Config, "logLevel" | "logsDir">): Logger {
  mkdirSync(config.logsDir, { recursive: true });

  // Per-stream levels do not accept "silent"; the logger level already gates it.
  const streamLevel: pino.Level = config.logLevel === "silent" ? "fatal" : config.logLevel;

  const streams: pino.StreamEntry[] = [
    { level: streamLevel, stream: pino.destination({ fd: 1, sync: false }) },
    {
      level: streamLevel,
      stream: pino.transport({
        target: "pino-roll",
        options: {
          file: join(config.logsDir, "amber.log"),
          size: "20m",
          limit: { count: 5 },
          mkdir: true,
        },
      }) as pino.DestinationStream,
    },
  ];

  return pino(
    {
      level: config.logLevel,
      base: { name: "amber" },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['cf-access-jwt-assertion']",
          "password",
          "secret",
          "*.password",
          "*.secret",
        ],
        censor: "[redacted]",
      },
    },
    pino.multistream(streams),
  );
}

/** stdout-only logger for tests and for failures that happen before config loads. */
export function createConsoleLogger(level: string = "info"): Logger {
  return pino({ level, base: { name: "amber" }, timestamp: pino.stdTimeFunctions.isoTime });
}
