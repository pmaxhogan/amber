import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

const cfEnv = {
  CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
  CF_ACCESS_AUD: "a".repeat(64),
  CF_ACCESS_ALLOWED_EMAILS: "owner@example.com",
};

describe("loadConfig - authentication gate", () => {
  it("boots when Cloudflare Access is fully configured", () => {
    const config = loadConfig({ ...cfEnv, DATA_DIR: "/data" });
    expect(config.insecureMode).toBe(false);
    expect(config.cfAccess?.teamDomain).toBe("example.cloudflareaccess.com");
    expect(config.cfAccess?.allowedEmails).toEqual(["owner@example.com"]);
  });

  it("refuses to boot with no auth and no insecure flag", () => {
    expect(() => loadConfig({ DATA_DIR: "/data" })).toThrow(ConfigError);
  });

  it("refuses to boot when Cloudflare Access is only partly configured", () => {
    expect(() =>
      loadConfig({ DATA_DIR: "/data", CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ ...cfEnv, CF_ACCESS_ALLOWED_EMAILS: "", DATA_DIR: "/data" })).toThrow(
      ConfigError,
    );
  });

  it("lowercases and trims the allowed email list", () => {
    const config = loadConfig({
      ...cfEnv,
      CF_ACCESS_ALLOWED_EMAILS: " Alice@Example.com , bob@example.com ,",
      DATA_DIR: "/data",
    });
    expect(config.cfAccess?.allowedEmails).toEqual(["alice@example.com", "bob@example.com"]);
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
