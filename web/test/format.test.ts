import { describe, expect, it } from "vitest";
import { deriveOutcome } from "../src/api/types.ts";
import {
  absoluteTime,
  forgeOrigin,
  formatDuration,
  humanBytes,
  pluralize,
  relativeTime,
  safeFileName,
} from "../src/lib/format.ts";

describe("humanBytes", () => {
  it("renders a dash for an unknown size", () => {
    expect(humanBytes(null)).toBe("-");
    expect(humanBytes(undefined)).toBe("-");
  });

  it("keeps raw bytes below a kilobyte", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(1023)).toBe("1023 B");
  });

  it("steps up units at 1024 and loses precision as it grows", () => {
    expect(humanBytes(1024)).toBe("1.00 KB");
    expect(humanBytes(1024 * 15)).toBe("15.0 KB");
    expect(humanBytes(1024 * 500)).toBe("500 KB");
    expect(humanBytes(1024 ** 3)).toBe("1.00 GB");
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;

  it("says never for a missing timestamp", () => {
    expect(relativeTime(null, now)).toBe("never");
  });

  it("collapses anything under a minute", () => {
    expect(relativeTime(now - 5_000, now)).toBe("just now");
  });

  it("reads past times as ago and future times as in", () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now + 2 * 3_600_000, now)).toBe("in 2 h");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3 d ago");
  });
});

describe("formatDuration", () => {
  it("switches units as the duration grows", () => {
    expect(formatDuration(820)).toBe("820 ms");
    expect(formatDuration(4200)).toBe("4.2 s");
    expect(formatDuration(185_000)).toBe("3 min 05 s");
  });

  it("renders a dash for an unknown duration", () => {
    expect(formatDuration(null)).toBe("-");
  });
});

describe("forgeOrigin", () => {
  it("leaves a default port implicit", () => {
    expect(forgeOrigin({ protocol: "https", host: "github.com", port: null })).toBe(
      "https://github.com",
    );
  });

  it("shows a non-default port", () => {
    expect(forgeOrigin({ protocol: "http", host: "git.local", port: 8080 })).toBe(
      "http://git.local:8080",
    );
  });
});

describe("safeFileName", () => {
  it("strips characters that do not belong in a file name", () => {
    expect(safeFileName("my repo/name")).toBe("my-repo-name");
  });

  it("falls back rather than producing an empty name", () => {
    expect(safeFileName("///")).toBe("amber-export");
  });
});

describe("pluralize", () => {
  it("uses the singular for exactly one", () => {
    expect(pluralize(1, "repository", "repositories")).toBe("1 repository");
    expect(pluralize(2, "repository", "repositories")).toBe("2 repositories");
    expect(pluralize(0, "line")).toBe("0 lines");
  });
});

describe("absoluteTime", () => {
  it("says never for a missing timestamp", () => {
    expect(absoluteTime(null)).toBe("never");
  });

  it("renders something for a real timestamp", () => {
    expect(absoluteTime(1_700_000_000_000)).not.toBe("never");
  });
});

describe("deriveOutcome", () => {
  const base = { lastSyncAt: null, lastSuccessAt: null, lastError: null };

  it("prefers an explicit outcome from the server", () => {
    expect(deriveOutcome({ ...base, lastOutcome: "canceled" })).toBe("canceled");
  });

  it("reports pending before the first sync", () => {
    expect(deriveOutcome(base)).toBe("pending");
  });

  it("infers success when the last success is not older than the last attempt", () => {
    expect(deriveOutcome({ lastSyncAt: 100, lastSuccessAt: 100, lastError: null })).toBe("success");
  });

  it("infers failure from a recorded error", () => {
    expect(deriveOutcome({ lastSyncAt: 200, lastSuccessAt: 100, lastError: "boom" })).toBe("error");
  });

  it("infers failure when the last attempt is newer than the last success", () => {
    expect(deriveOutcome({ lastSyncAt: 200, lastSuccessAt: 100, lastError: null })).toBe("error");
  });
});
