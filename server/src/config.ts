import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Every environment variable Amber reads, validated once at boot. Nothing else
 * in the codebase touches process.env. Anything that is not deployment
 * fundamental belongs in the settings registry, not here.
 */

const csvEmails = z
  .string()
  .transform((raw) =>
    raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part !== ""),
  )
  .pipe(z.array(z.string().min(3)));

const booleanFlag = z
  .string()
  .transform((raw) => raw.trim().toLowerCase())
  .pipe(z.enum(["1", "0", "true", "false", "yes", "no", ""]))
  .transform((raw) => raw === "1" || raw === "true" || raw === "yes");

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  DATA_DIR: z.string().min(1).default("/data"),
  BACKUPS_DIR: z.string().min(1).optional(),
  STATE_DIR: z.string().min(1).optional(),
  LOGS_DIR: z.string().min(1).optional(),
  /** 64 hex chars: the AES-256-GCM key for account credentials. */
  AMBER_SECRET_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "AMBER_SECRET_KEY must be 64 hex characters")
    .optional(),
  CF_ACCESS_TEAM_DOMAIN: z.string().min(1).optional(),
  CF_ACCESS_AUD: z.string().min(1).optional(),
  CF_ACCESS_ALLOWED_EMAILS: csvEmails.optional(),
  INSECURE_ALLOW_PUBLIC_ACCESS: booleanFlag.default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Used to build the clone URLs shown in the UI. Deployments must set this;
  // the default only makes sense for local development.
  PUBLIC_ORIGIN: z.string().url().default("http://localhost:8080"),
  /**
   * Where the built single page app lives. Defaults to web/dist resolved
   * against this module, which is correct both in the image (/app/server/dist
   * next to /app/web/dist) and when running from the repo.
   */
  WEB_DIST_DIR: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  nodeEnv: Env["NODE_ENV"];
  port: number;
  /** Forced to 127.0.0.1 in insecure mode, whatever HOST said. */
  host: string;
  dataDir: string;
  backupsDir: string;
  stateDir: string;
  logsDir: string;
  dbPath: string;
  secretKey: Buffer | null;
  logLevel: Env["LOG_LEVEL"];
  publicOrigin: string;
  /** Absolute path to the built SPA. The app serves it when it exists. */
  webDistDir: string;
  insecureMode: boolean;
  cfAccess: {
    teamDomain: string;
    aud: string;
    allowedEmails: readonly string[];
  } | null;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Parse and validate the environment. Throws ConfigError with an actionable
 * message rather than booting into a half-configured state.
 *
 * Security rule: Amber refuses to start without Cloudflare Access configured
 * unless INSECURE_ALLOW_PUBLIC_ACCESS=1, in which case it binds loopback only.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment:\n${details}`);
  }
  const env = parsed.data;

  const dataDir = resolve(env.DATA_DIR);
  const backupsDir = resolve(env.BACKUPS_DIR ?? `${dataDir}/backups`);
  const stateDir = resolve(env.STATE_DIR ?? `${dataDir}/state`);
  const logsDir = resolve(env.LOGS_DIR ?? `${dataDir}/logs`);

  const insecureMode = env.INSECURE_ALLOW_PUBLIC_ACCESS;
  const hasCfAccess =
    env.CF_ACCESS_TEAM_DOMAIN !== undefined &&
    env.CF_ACCESS_AUD !== undefined &&
    env.CF_ACCESS_ALLOWED_EMAILS !== undefined &&
    env.CF_ACCESS_ALLOWED_EMAILS.length > 0;

  if (!insecureMode && !hasCfAccess) {
    throw new ConfigError(
      "Cloudflare Access is not configured. Set CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD and " +
        "CF_ACCESS_ALLOWED_EMAILS, or set INSECURE_ALLOW_PUBLIC_ACCESS=1 to run without " +
        "authentication bound to 127.0.0.1 only.",
    );
  }

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    // Insecure mode is loopback only, no matter what HOST says.
    host: insecureMode ? "127.0.0.1" : env.HOST,
    dataDir,
    backupsDir,
    stateDir,
    logsDir,
    dbPath: `${stateDir}/amber.db`,
    secretKey: env.AMBER_SECRET_KEY === undefined ? null : Buffer.from(env.AMBER_SECRET_KEY, "hex"),
    logLevel: env.LOG_LEVEL,
    publicOrigin: env.PUBLIC_ORIGIN.replace(/\/+$/, ""),
    webDistDir: resolve(
      env.WEB_DIST_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
    ),
    insecureMode,
    cfAccess:
      insecureMode || !hasCfAccess
        ? null
        : {
            teamDomain: env.CF_ACCESS_TEAM_DOMAIN as string,
            aud: env.CF_ACCESS_AUD as string,
            allowedEmails: env.CF_ACCESS_ALLOWED_EMAILS as string[],
          },
  };
}
