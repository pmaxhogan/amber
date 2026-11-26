import { describe, expect, it } from "vitest";
import { GONE_CONFIRM_MS } from "@amber/shared";
import { goneRecheckCapMs, GONE_RECHECK_MS, GONE_RECHECK_WINDOW_MS } from "../src/sync/backoff.ts";
import { judgeGone, type GoneFacts } from "../src/sync/gone.ts";

const T0 = 5_000_000_000_000;
const HOUR = 60 * 60 * 1000;

const DMCA =
  "git fetch failed (128): remote: Repository unavailable due to DMCA takedown.\n" +
  "remote: See the takedown notice for more details:\n" +
  "remote:   https://github.com/github/dmca/blob/master/2026/11/2026-11-24-take-two.md.\n" +
  "fatal: unable to access 'https://github.com/realdody/Leonida.git/': The requested URL returned error: 403";

function facts(overrides: Partial<GoneFacts> = {}): GoneFacts {
  return {
    errorKind: "not_found",
    error: "git fetch failed (128): remote: Repository not found.",
    forgeKind: "github",
    lastSuccessAt: T0 - 3 * HOUR,
    goneAt: null,
    consecutiveFailures: 2,
    unreachableSince: T0,
    now: T0 + GONE_CONFIRM_MS,
    ...overrides,
  };
}

describe("judgeGone", () => {
  it("is not fooled by a repository the forge hides for a couple of hours", () => {
    // Measured on the live instance 2026-11-24..26: public repositories that
    // answered "Repository not found" for 1.2h and 2.2h, then synced again.
    // Two failures arrive within three minutes of each other, so counting
    // failures alone called every one of them removed.
    expect(judgeGone(facts({ now: T0 + 2 * 60_000 }))).toBeNull();
    expect(judgeGone(facts({ consecutiveFailures: 9, now: T0 + 2.2 * HOUR }))).toBeNull();
    expect(judgeGone(facts({ consecutiveFailures: 12, now: T0 + GONE_CONFIRM_MS - 1 }))).toBeNull();
  });

  it("calls it gone once the forge has kept saying so for the whole window", () => {
    expect(judgeGone(facts())).toBe("not_found");
    expect(judgeGone(facts({ errorKind: "auth", error: "Authentication failed" }))).toBe("auth");
  });

  it("still needs more than one answer, however far apart", () => {
    expect(judgeGone(facts({ consecutiveFailures: 1, now: T0 + 48 * HOUR }))).toBeNull();
  });

  it("only counts the kinds that mean the repository is not there", () => {
    for (const errorKind of [
      "network",
      "timeout",
      "rate_limited",
      "disk",
      "git",
      "other",
    ] as const) {
      expect(judgeGone(facts({ errorKind }))).toBeNull();
    }
    expect(judgeGone(facts({ errorKind: null, error: null }))).toBeNull();
  });

  it("never calls gone what never synced, or what is already gone", () => {
    expect(judgeGone(facts({ lastSuccessAt: null }))).toBeNull();
    expect(judgeGone(facts({ goneAt: T0 - HOUR }))).toBeNull();
  });

  it("takes a GitHub DMCA takedown at its word on the first answer", () => {
    expect(
      judgeGone(
        facts({
          errorKind: "auth",
          error: DMCA,
          consecutiveFailures: 1,
          now: T0,
          unreachableSince: T0,
        }),
      ),
    ).toBe("dmca_takedown");
  });

  it("gives the same words no such weight on another forge", () => {
    expect(
      judgeGone(facts({ errorKind: "auth", error: DMCA, forgeKind: "generic", now: T0 })),
    ).toBeNull();
    expect(judgeGone(facts({ lastSuccessAt: null, errorKind: "auth", error: DMCA }))).toBeNull();
  });
});

describe("goneRecheckCapMs", () => {
  const interval = 3 * HOUR;

  it("leaves a reachable repository on its own interval", () => {
    expect(goneRecheckCapMs(interval, null, T0)).toBe(interval);
  });

  it("looks again within the hour while a repository is freshly gone", () => {
    expect(goneRecheckCapMs(interval, T0, T0)).toBe(GONE_RECHECK_MS);
    expect(goneRecheckCapMs(interval, T0, T0 + GONE_RECHECK_WINDOW_MS - 1)).toBe(GONE_RECHECK_MS);
  });

  it("never checks less often than the repository's own interval asks for", () => {
    expect(goneRecheckCapMs(10 * 60_000, T0, T0)).toBe(10 * 60_000);
  });

  it("goes back to the normal interval for what has stayed gone", () => {
    expect(goneRecheckCapMs(interval, T0, T0 + GONE_RECHECK_WINDOW_MS)).toBe(interval);
  });
});
