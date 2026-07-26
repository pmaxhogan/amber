import { mkdirSync } from "node:fs";
import { buildApp, INSECURE_BANNER } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { openDb } from "./db/db.ts";
import { createConsoleLogger, createLogger } from "./logging.ts";
import { APP_VERSION } from "./version.ts";

/** How often insecure mode re-warns, so it never goes unnoticed in a long run. */
const INSECURE_REMINDER_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();

  for (const dir of [config.dataDir, config.backupsDir, config.stateDir, config.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const log = createLogger(config);
  log.info(
    { version: APP_VERSION, dataDir: config.dataDir, insecureMode: config.insecureMode },
    "amber starting",
  );

  const db = openDb(config.dbPath);
  migrate(db, log.child({ mod: "migrate" }));

  const app = await buildApp({ config, log, db, version: APP_VERSION });

  const reminder = config.insecureMode
    ? setInterval(() => {
        log.warn(INSECURE_BANNER);
      }, INSECURE_REMINDER_MS)
    : null;
  reminder?.unref();

  const shutdown = (signal: string): void => {
    log.info({ signal }, "shutting down");
    if (reminder !== null) {
      clearInterval(reminder);
    }
    void app
      .close()
      .then(() => {
        db.close();
        process.exit(0);
      })
      .catch((error: unknown) => {
        log.error({ err: error }, "error during shutdown");
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  await app.listen({ port: config.port, host: config.host });
  log.info({ port: config.port, host: config.host }, "amber listening");
}

main().catch((error: unknown) => {
  // The pino logger may not exist yet, so fall back to a stdout-only one.
  const log = createConsoleLogger();
  if (error instanceof ConfigError) {
    log.fatal(error.message);
  } else {
    log.fatal({ err: error }, "failed to start");
  }
  process.exit(1);
});
