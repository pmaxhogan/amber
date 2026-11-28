import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, RedactedSecret } from "../src/config.ts";

const cfEnv = {
  CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
  CF_ACCESS_AUD: "a".repeat(64),
  AMBER_ADMIN_EMAIL: "owner@example.com",
};

const policyEnv = {
  CF_API_TOKEN: "cf-token-0123456789",
  CF_ACCOUNT_ID: "acct-0123",
  CF_ACCESS_POLICY_ID: "policy-4567",
};

describe("loadConfig - authentication gate", () => {
  it("boots when Cloudflare Access is fully configured", () => {
    const config = loadConfig({ ...cfEnv, DATA_DIR: "/data" });
    expect(config.insecureMode).toBe(false);
    expect(config.cfAccess).toEqual({
      teamDomain: "example.cloudflareaccess.com",
      aud: "a".repeat(64),
    });
    expect(config.adminEmail).toBe("owner@example.com");
    expect(config.adminEmailSource).toBe("env");
  });

  it("refuses to boot with no auth and no insecure flag", () => {
    expect(() => loadConfig({ DATA_DIR: "/data" })).toThrow(ConfigError);
  });

  it("refuses to boot when Cloudflare Access is only partly configured", () => {
    expect(() =>
      loadConfig({ DATA_DIR: "/data", CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }),
    ).toThrow(ConfigError);
    // No admin at all: nobody could ever be let in.
    expect(() => loadConfig({ ...cfEnv, AMBER_ADMIN_EMAIL: "", DATA_DIR: "/data" })).toThrow(
      /AMBER_ADMIN_EMAIL/,
    );
  });

  it("lowercases and trims the admin email", () => {
    const config = loadConfig({
      ...cfEnv,
      AMBER_ADMIN_EMAIL: "  Owner@Example.COM ",
      DATA_DIR: "/d",
    });
    expect(config.adminEmail).toBe("owner@example.com");
  });

  it("rejects an admin email that is not an address", () => {
    expect(() => loadConfig({ ...cfEnv, AMBER_ADMIN_EMAIL: "nobody", DATA_DIR: "/d" })).toThrow(
      ConfigError,
    );
  });

  it("rejects email addresses that are not plain ASCII, before case folding", () => {
    // U+212A KELVIN SIGN lower-cases to "k"; it must not pass as kim@example.com.
    for (const AMBER_ADMIN_EMAIL of ["\u212aim@example.com", "caf\u00e9@example.com"]) {
      expect(() => loadConfig({ ...cfEnv, AMBER_ADMIN_EMAIL, DATA_DIR: "/d" })).toThrow(
        /AMBER_ADMIN_EMAIL/,
      );
    }
    expect(() =>
      loadConfig({
        INSECURE_ALLOW_PUBLIC_ACCESS: "1",
        INSECURE_USER_EMAILS: "ok@example.com,\u212aok@example.com",
        DATA_DIR: "/d",
      }),
    ).toThrow(/plain ASCII/);
  });
});

describe("loadConfig - legacy CF_ACCESS_ALLOWED_EMAILS", () => {
  const legacy = {
    CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    CF_ACCESS_AUD: "aud",
    DATA_DIR: "/d",
  };

  it("makes the FIRST entry the admin when AMBER_ADMIN_EMAIL is unset", () => {
    const config = loadConfig({
      ...legacy,
      CF_ACCESS_ALLOWED_EMAILS: " Alice@Example.com , bob@example.com ,",
    });
    expect(config.adminEmail).toBe("alice@example.com");
    expect(config.adminEmailSource).toBe("legacy");
  });

  it("is ignored entirely once AMBER_ADMIN_EMAIL is set", () => {
    const config = loadConfig({
      ...legacy,
      AMBER_ADMIN_EMAIL: "carol@example.com",
      CF_ACCESS_ALLOWED_EMAILS: "alice@example.com",
    });
    expect(config.adminEmail).toBe("carol@example.com");
    expect(config.adminEmailSource).toBe("env");
  });

  it("does not satisfy the gate when it is empty", () => {
    expect(() => loadConfig({ ...legacy, CF_ACCESS_ALLOWED_EMAILS: "" })).toThrow(ConfigError);
  });
});

describe("loadConfig - access policy trio", () => {
  it("is admin-only when none of the three is set", () => {
    expect(loadConfig({ ...cfEnv, DATA_DIR: "/d" }).accessPolicy).toBeNull();
  });

  it("reads all three together", () => {
    const config = loadConfig({ ...cfEnv, ...policyEnv, DATA_DIR: "/d" });
    expect(config.accessPolicy?.accountId).toBe("acct-0123");
    expect(config.accessPolicy?.policyId).toBe("policy-4567");
    expect(config.accessPolicy?.apiToken.reveal()).toBe("cf-token-0123456789");
  });

  it("refuses to start on any partial set, naming what is missing", () => {
    const names = Object.keys(policyEnv) as (keyof typeof policyEnv)[];
    for (const omitted of names) {
      const env: Record<string, string> = { ...cfEnv, ...policyEnv, DATA_DIR: "/d" };
      delete env[omitted];
      expect(() => loadConfig(env), omitted).toThrow(new RegExp(`Missing: .*${omitted}`));
    }
    for (const only of names) {
      expect(() => loadConfig({ ...cfEnv, DATA_DIR: "/d", [only]: policyEnv[only] }), only).toThrow(
        ConfigError,
      );
    }
  });

  it("treats blank values as unset", () => {
    const config = loadConfig({
      ...cfEnv,
      CF_API_TOKEN: " ",
      CF_ACCOUNT_ID: "",
      CF_ACCESS_POLICY_ID: "",
      DATA_DIR: "/d",
    });
    expect(config.accessPolicy).toBeNull();
  });

  it("never lets the token reach a log line, a JSON body or inspect output", () => {
    const config = loadConfig({ ...cfEnv, ...policyEnv, DATA_DIR: "/d" });
    expect(JSON.stringify(config)).not.toContain("cf-token-0123456789");
    expect(inspect(config, { depth: 10 })).not.toContain("cf-token-0123456789");
    expect(`${String(config.accessPolicy?.apiToken)}`).toBe("[redacted]");
    expect(new RedactedSecret("x").toJSON()).toBe("[redacted]");
  });

  it("is never used in insecure mode", () => {
    const config = loadConfig({
      ...cfEnv,
      ...policyEnv,
      INSECURE_ALLOW_PUBLIC_ACCESS: "1",
      DATA_DIR: "/d",
    });
    expect(config.accessPolicy).toBeNull();
  });
});

describe("loadConfig - INSECURE_USER_EMAILS", () => {
  it("is honoured in insecure mode only", () => {
    const insecure = loadConfig({
      INSECURE_ALLOW_PUBLIC_ACCESS: "1",
      DATA_DIR: "/d",
      INSECURE_USER_EMAILS: "Friend@Example.com, other@example.com",
    });
    expect(insecure.insecureUserEmails).toEqual(["friend@example.com", "other@example.com"]);

    const secure = loadConfig({
      ...cfEnv,
      DATA_DIR: "/d",
      INSECURE_USER_EMAILS: "friend@example.com",
    });
    expect(secure.insecureUserEmails).toEqual([]);
  });
});

describe("loadConfig - insecure mode", () => {
  it("binds loopback only, overriding HOST", () => {
    const config = loadConfig({
      INSECURE_ALLOW_PUBLIC_ACCESS: "1",
      HOST: "0.0.0.0",
      DATA_DIR: "/data",
    });
    expect(config.insecureMode).toBe(true);
    expect(config.host).toBe("127.0.0.1");
    expect(config.cfAccess).toBeNull();
  });

  it("ignores Cloudflare Access settings when insecure mode is on", () => {
    const config = loadConfig({
      ...cfEnv,
      INSECURE_ALLOW_PUBLIC_ACCESS: "true",
      DATA_DIR: "/data",
    });
    expect(config.insecureMode).toBe(true);
    expect(config.cfAccess).toBeNull();
  });

  it("treats 0, false, and absent as off", () => {
    expect(() => loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "0", DATA_DIR: "/d" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "false", DATA_DIR: "/d" })).toThrow(
      ConfigError,
    );
  });

  it("rejects a value that is neither truthy nor falsy", () => {
    expect(() => loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "maybe", DATA_DIR: "/d" })).toThrow(
      ConfigError,
    );
  });
});

describe("loadConfig - derived directories", () => {
  it("derives backups, state, and logs from DATA_DIR", () => {
    const config = loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "1", DATA_DIR: "/srv/amber" });
    expect(config.backupsDir.endsWith("backups")).toBe(true);
    expect(config.stateDir.endsWith("state")).toBe(true);
    expect(config.logsDir.endsWith("logs")).toBe(true);
    expect(config.dbPath.endsWith("amber.db")).toBe(true);
  });

  it("lets each directory be overridden independently", () => {
    const config = loadConfig({
      INSECURE_ALLOW_PUBLIC_ACCESS: "1",
      DATA_DIR: "/srv/amber",
      BACKUPS_DIR: "/mnt/big/backups",
    });
    expect(config.backupsDir).toContain("big");
    expect(config.stateDir).toContain("amber");
  });
});

describe("loadConfig - validation", () => {
  it("rejects a malformed secret key", () => {
    expect(() =>
      loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "1", DATA_DIR: "/d", AMBER_SECRET_KEY: "nope" }),
    ).toThrow(/64 hex characters/);
  });

  it("accepts a 64 hex character secret key and decodes it to 32 bytes", () => {
    const config = loadConfig({
      INSECURE_ALLOW_PUBLIC_ACCESS: "1",
      DATA_DIR: "/d",
      AMBER_SECRET_KEY: "ab".repeat(32),
    });
    expect(config.secretKey?.length).toBe(32);
  });

  it("rejects an out of range port and a bad log level", () => {
    expect(() =>
      loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "1", DATA_DIR: "/d", PORT: "70000" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "1", DATA_DIR: "/d", LOG_LEVEL: "chatty" }),
    ).toThrow(ConfigError);
  });

  it("defaults port, log level, and public origin", () => {
    const config = loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "1", DATA_DIR: "/d" });
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("info");
    expect(config.publicOrigin).toBe("http://localhost:8080");
  });

  it("strips a trailing slash from PUBLIC_ORIGIN", () => {
    const config = loadConfig({
      INSECURE_ALLOW_PUBLIC_ACCESS: "1",
      DATA_DIR: "/d",
      PUBLIC_ORIGIN: "https://amber.example.com/",
    });
    expect(config.publicOrigin).toBe("https://amber.example.com");
  });
});
