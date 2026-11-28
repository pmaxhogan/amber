import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { z } from "zod";

/**
 * Every environment variable Amber reads, validated once at boot. Nothing else
 * in the codebase touches process.env. Anything that is not deployment
 * fundamental belongs in the settings registry, not here.
 */

/**
 * Printable ASCII, judged before lower casing, exactly like domain/users.ts
 * normalizeEmail (config sits below the domain layer, so the rule is repeated
 * rather than imported). An identity with any other address is refused, so
 * configuring one would only lock that person out.
 */
const PLAIN_ASCII = /^[\x21-\x7e]+$/;
const ASCII_MESSAGE = "email addresses must be plain ASCII";

const csvEmails = z
  .string()
  .transform((raw) =>
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== ""),
  )
  .pipe(z.array(z.string().min(3).regex(PLAIN_ASCII, ASCII_MESSAGE)))
  .transform((parts) => parts.map((part) => part.toLowerCase()));

/** One address, normalized the way identity.ts normalizes the email claim. */
const singleEmail = z
  .string()
  .transform((raw) => raw.trim())
  .pipe(z.string().min(3).includes("@").regex(PLAIN_ASCII, ASCII_MESSAGE))
  .transform((raw) => raw.toLowerCase());

/** Empty means "not set", so a blank line in a .env file is not a value. */
const optionalString = z
  .string()
  .transform((raw) => raw.trim())
  .transform((raw) => (raw === "" ? undefined : raw))
  .optional();

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
  /**
   * LEGACY. Replaced by AMBER_ADMIN_EMAIL plus the Cloudflare Access policy.
   * Read only so an upgrade keeps booting: when AMBER_ADMIN_EMAIL is unset,
   * the FIRST entry becomes the admin and the rest are ignored.
   */
  CF_ACCESS_ALLOWED_EMAILS: csvEmails.optional(),
  /** The one admin. Cannot be changed from the UI or the API. */
  AMBER_ADMIN_EMAIL: z
    .string()
    .transform((raw) => raw.trim())
    .pipe(z.union([z.literal(""), singleEmail]))
    .transform((raw) => (raw === "" ? undefined : raw))
    .optional(),
  /**
   * The reusable Access policy whose explicit email entries are the users.
   * All three or none: without them Amber is admin-only.
   */
  CF_API_TOKEN: optionalString,
  CF_ACCOUNT_ID: optionalString,
  CF_ACCESS_POLICY_ID: optionalString,
  /** Insecure mode only: stands in for the access policy in tests and local development. */
  INSECURE_USER_EMAILS: csvEmails.optional(),
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

/**
 * Wraps a credential so it cannot reach a log or a response by accident.
 * pino serializes with JSON.stringify, which calls toJSON; util.inspect and
 * template strings get the same placeholder. The only way to the value is
 * reveal(), which is greppable.
 */
export class RedactedSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[redacted]";
  }

  toString(): string {
    return "[redacted]";
  }

  [inspect.custom](): string {
    return "[redacted]";
  }
}

/** Where the admin email came from, so boot can warn about the legacy variable. */
export type AdminEmailSource = "env" | "legacy" | null;

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
  } | null;
  /**
   * The one admin, lower case. Always set outside insecure mode. In insecure
   * mode it may be null, and the admin row keeps its placeholder address.
   */
  adminEmail: string | null;
  adminEmailSource: AdminEmailSource;
  /** The reusable Access policy that lists the users, or null for admin-only. */
  accessPolicy: {
    accountId: string;
    policyId: string;
    apiToken: RedactedSecret;
  } | null;
  /** Insecure mode only, and empty otherwise: the stand-in user list. */
  insecureUserEmails: readonly string[];
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

  const legacyAdmin = env.CF_ACCESS_ALLOWED_EMAILS?.[0];
  const adminEmail = env.AMBER_ADMIN_EMAIL ?? legacyAdmin ?? null;
  const adminEmailSource: AdminEmailSource =
    env.AMBER_ADMIN_EMAIL !== undefined ? "env" : legacyAdmin !== undefined ? "legacy" : null;

  const hasCfAccess =
    env.CF_ACCESS_TEAM_DOMAIN !== undefined &&
    env.CF_ACCESS_AUD !== undefined &&
    adminEmail !== null;

  if (!insecureMode && !hasCfAccess) {
    throw new ConfigError(
      "Cloudflare Access is not configured. Set CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD and " +
        "AMBER_ADMIN_EMAIL, or set INSECURE_ALLOW_PUBLIC_ACCESS=1 to run without " +
        "authentication bound to 127.0.0.1 only.",
    );
  }

  // All three or none: a partial set would be an admin-only instance that
  // looks configured, and the missing piece only shows up as everyone else
  // being refused.
  const policyParts = {
    CF_API_TOKEN: env.CF_API_TOKEN,
    CF_ACCOUNT_ID: env.CF_ACCOUNT_ID,
    CF_ACCESS_POLICY_ID: env.CF_ACCESS_POLICY_ID,
  };
  const policySet = Object.entries(policyParts).filter(([, value]) => value !== undefined);
  if (policySet.length !== 0 && policySet.length !== 3) {
    const missing = Object.entries(policyParts)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    throw new ConfigError(
      "CF_API_TOKEN, CF_ACCOUNT_ID and CF_ACCESS_POLICY_ID are set together or not at all. " +
        `Missing: ${missing.join(", ")}.`,
    );
  }
  const accessPolicy =
    policySet.length === 3
      ? {
          accountId: env.CF_ACCOUNT_ID as string,
          policyId: env.CF_ACCESS_POLICY_ID as string,
          apiToken: new RedactedSecret(env.CF_API_TOKEN as string),
        }
      : null;

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
          },
    adminEmail,
    adminEmailSource,
    // The stand-in list never applies with real authentication: it would be a
    // second, unaudited allow list sitting next to the policy.
    accessPolicy: insecureMode ? null : accessPolicy,
    insecureUserEmails: insecureMode ? (env.INSECURE_USER_EMAILS ?? []) : [],
  };
}
