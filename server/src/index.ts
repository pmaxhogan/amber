import { mkdirSync } from "node:fs";
import { startAccountSyncTimer } from "./accountSyncTimer.ts";
import { buildApp, INSECURE_BANNER } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { openDb } from "./db/db.ts";
import { EventBus } from "./events.ts";
import { createConsoleLogger, createLogger } from "./logging.ts";
import { createBackupFileRemover } from "./routes/repos.ts";
import { ensureGitRuntime } from "./sync/gitCli.ts";
import { Scheduler } from "./sync/scheduler.ts";
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

  // Builds the scrubbed HOME and the askpass helper the git wrapper runs with.
  // Done before anything can spawn git rather than lazily inside the first
  // fetch, so a broken state dir fails at boot instead of mid-sync.
  ensureGitRuntime(config.stateDir);

  // One bus shared by the API's SSE stream and the sync engine, so a sync
  // started by the scheduler shows up in a browser that never asked for it.
  const events = new EventBus();

  const scheduler = new Scheduler({
    db,
    backupsDir: config.backupsDir,
    stateDir: config.stateDir,
    logger: log,
    events,
    secretKey: config.secretKey,
  });

  const app = await buildApp({ config, log, db, events, version: APP_VERSION, scheduler });

  const accountSync = startAccountSyncTimer({
    db,
    log,
    secretKey: config.secretKey,
    removeFiles: createBackupFileRemover(config),
  });

  const reminder = config.insecureMode
    ? setInterval(() => {
        log.warn(INSECURE_BANNER);
      }, INSECURE_REMINDER_MS)
    : null;
  reminder?.unref();

  /**
   * Stop taking work, then let the work in flight finish. Scheduler.stop()
   * waits for running syncs and shuts the git children down itself, so
   * shutdownGit is never called here as well. The database closes last
   * because a draining sync is still writing its run row.
   */
  const shutdown = (signal: string): void => {
    log.info({ signal }, "shutting down");
    if (reminder !== null) {
      clearInterval(reminder);
    }
    accountSync.stop();
    void app
      .close()
      .then(() => scheduler.stop())
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

  // Started after listen so the health check can answer while the startup
  // catch-up sweep works through whatever came due during the downtime.
  await scheduler.start();
  log.info("sync scheduler started");
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
