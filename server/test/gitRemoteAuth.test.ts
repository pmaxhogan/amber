import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findUserByEmail,
  getAdminUser,
  reconcileUsers,
  requireUser,
  revokeGitPassword,
} from "../src/domain/users.ts";
import {
  authenticateGitRequest,
  dummyGitPasswordHash,
  type GitAuthDeps,
  type GitAuthResult,
} from "../src/gitremote/auth.ts";
import { setGitRemoteEnabled } from "../src/gitremote/config.ts";
import {
  findGitCredential,
  generateGitUsername,
  GIT_USERNAME_LENGTH,
  isWellFormedGitUsername,
  mintGitCredential,
  toGitRemoteMe,
} from "../src/gitremote/credentials.ts";
import { AuthThrottle, DEFAULT_THROTTLE_ADDRESS_CAPACITY } from "../src/gitremote/throttle.ts";
import type { MembershipDecision } from "../src/security/accessPolicy.ts";
import { SCRYPT_PARAMS, verifyGitPassword } from "../src/security/gitPassword.ts";
import { createTempDb, type TempDb } from "./helpers.ts";

/**
 * The /git authentication order, one branch at a time, against a real
 * database. The HTTP and real-git behaviour is pinned in gitRemotePerUser and
 * gitRemotePolicy; this file is where each branch is proven to run (or not
 * run) the password derivation and to charge (or not charge) the throttle.
 */

const FRIEND = "friend@example.com";
const OTHER = "other@example.com";
const IP = "203.0.113.7";

let temp: TempDb;
let throttle: AuthThrottle;
let verified: string[];
let membership: { calls: string[]; decide: (email: string) => Promise<MembershipDecision> };

function deps(): GitAuthDeps {
  return {
    db: temp.db,
    throttle,
    policy: {
      membership: (email) => {
        membership.calls.push(email);
        return membership.decide(email);
      },
    },
    // The real verifier, recorded: the hash each call derived against.
    verifyPassword: (password, stored) => {
      verified.push(stored);
      return verifyGitPassword(password, stored);
    },
  };
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function attempt(authorization: unknown): Promise<GitAuthResult> {
  return await authenticateGitRequest(deps(), { authorization, ip: IP });
}

function userId(email: string): number {
  const user = findUserByEmail(temp.db, email);
  if (user === undefined) {
    throw new Error(`no row for ${email}`);
  }
  return user.id;
}

/**
 * How many failures the attempts so far charged to IP. AuthThrottle exposes no
 * token count, so this spends the rest of the budget and counts; call it last.
 */
function failuresCharged(): number {
  let left = 0;
  while (throttle.allowAddress(IP) && left < 100) {
    throttle.recordFailure(IP, `probe${String(left)}`);
    left += 1;
  }
  return DEFAULT_THROTTLE_ADDRESS_CAPACITY - left;
}

beforeEach(() => {
  temp = createTempDb();
  reconcileUsers(temp.db, [FRIEND, OTHER]);
  setGitRemoteEnabled(temp.db, true);
  throttle = new AuthThrottle();
  verified = [];
  membership = { calls: [], decide: () => Promise.resolve("allow") };
});

afterEach(() => {
  temp.close();
});

describe("git credentials", () => {
  it("generates 10 lower-case alphanumerics", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const name = generateGitUsername();
      expect(name).toHaveLength(GIT_USERNAME_LENGTH);
      expect(isWellFormedGitUsername(name)).toBe(true);
      seen.add(name);
    }
    // 36^10 names: any repeat in 500 draws means the source is not random.
    expect(seen.size).toBe(500);
  });

  it("never derives the username from the email or the row id", () => {
    const id = userId(FRIEND);
    const { username } = mintGitCredential(temp.db, id);
    expect(username).not.toContain("friend");
    expect(username).not.toBe(String(id).padStart(10, "0"));
  });

  it("assigns a username on first mint and keeps it across rotations", () => {
    const id = userId(FRIEND);
    const first = mintGitCredential(temp.db, id);
    const second = mintGitCredential(temp.db, id);
    expect(second.username).toBe(first.username);
    expect(second.password).not.toBe(first.password);
    expect(requireUser(temp.db, id).gitUsername).toBe(first.username);

    // Rotation replaced the hash: the old password no longer verifies.
    const stored = findGitCredential(temp.db, first.username);
    expect(stored).toBeDefined();
    expect(verifyGitPassword(first.password, stored!.passwordHash)).toBe(false);
    expect(verifyGitPassword(second.password, stored!.passwordHash)).toBe(true);
  });

  it("keeps the username through a revoke, so a re-mint keeps the clone URLs", () => {
    const id = userId(FRIEND);
    const first = mintGitCredential(temp.db, id);
    revokeGitPassword(temp.db, id);
    expect(findGitCredential(temp.db, first.username)).toBeUndefined();
    expect(mintGitCredential(temp.db, id).username).toBe(first.username);
  });

  it("stores only a scrypt hash, never the password", () => {
    const id = userId(FRIEND);
    const { password } = mintGitCredential(temp.db, id);
    const row = temp.db.get<{ git_password_hash: string }>(
      "SELECT git_password_hash FROM users WHERE id = ?",
      id,
    );
    expect(row?.git_password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(row?.git_password_hash).not.toContain(password);
  });

  it("never gives two users the same username, even when the generator collides", () => {
    const first = mintGitCredential(temp.db, userId(FRIEND));
    const names = [first.username, first.username, "zzzzzzzzz9"];
    const second = mintGitCredential(temp.db, userId(OTHER), {
      generateUsername: () => names.shift() as string,
    });
    expect(second.username).toBe("zzzzzzzzz9");
    expect(second.username).not.toBe(first.username);
  });

  it("gives up rather than sharing a name when every draw collides", () => {
    const first = mintGitCredential(temp.db, userId(FRIEND));
    expect(() =>
      mintGitCredential(temp.db, userId(OTHER), { generateUsername: () => first.username }),
    ).toThrow(/free git username/);
    const other = requireUser(temp.db, userId(OTHER));
    expect(other.gitUsername).toBeNull();
    expect(other.hasGitPassword).toBe(false);
  });

  it("refuses to mint for a removed user", () => {
    const id = userId(FRIEND);
    reconcileUsers(temp.db, [OTHER]);
    expect(() => mintGitCredential(temp.db, id)).toThrow(/removed user/);
    expect(requireUser(temp.db, id).hasGitPassword).toBe(false);
  });

  it("describes the caller's state without a secret", () => {
    const id = userId(FRIEND);
    const none = toGitRemoteMe(temp.db, requireUser(temp.db, id), "https://amber.example.com");
    expect(none).toEqual({
      enabled: true,
      username: null,
      hasPassword: false,
      rotatedAt: null,
      cloneUrlTemplate: null,
    });
    const minted = mintGitCredential(temp.db, id, { now: 1_800_000_000_000 });
    const me = toGitRemoteMe(temp.db, requireUser(temp.db, id), "https://amber.example.com");
    expect(me).toEqual({
      enabled: true,
      username: minted.username,
      hasPassword: true,
      rotatedAt: 1_800_000_000_000,
      cloneUrlTemplate: `https://${minted.username}:{password}@amber.example.com/git/{slug}.git`,
    });
    expect(JSON.stringify(me)).not.toContain(minted.password);
  });
});

describe("the dummy hash", () => {
  it("is a real record with the current parameters, so it costs a full derivation", () => {
    const [scheme, n, r, p, salt, hash] = dummyGitPasswordHash().split("$");
    expect(scheme).toBe("scrypt");
    expect(Number(n)).toBe(SCRYPT_PARAMS.N);
    expect(Number(r)).toBe(SCRYPT_PARAMS.r);
    expect(Number(p)).toBe(SCRYPT_PARAMS.p);
    expect(Buffer.from(salt as string, "base64")).toHaveLength(16);
    expect(Buffer.from(hash as string, "base64")).toHaveLength(SCRYPT_PARAMS.keylen);
  });

  it("is fixed for the process and matches nothing anyone can send", () => {
    expect(dummyGitPasswordHash()).toBe(dummyGitPasswordHash());
    expect(verifyGitPassword("", dummyGitPasswordHash())).toBe(false);
    expect(verifyGitPassword("amber", dummyGitPasswordHash())).toBe(false);
  });
});

describe("the /git authentication order", () => {
  it("1. answers 404 while the kill switch is off, before reading any credential", async () => {
    const minted = mintGitCredential(temp.db, userId(FRIEND));
    setGitRemoteEnabled(temp.db, false);
    const result = await attempt(basic(minted.username, minted.password));
    expect(result).toEqual({ ok: false, status: 404, reason: "disabled" });
    expect(verified).toEqual([]);
    expect(membership.calls).toEqual([]);
  });

  it("2. throttles an address with no budget left, before deriving anything", async () => {
    const minted = mintGitCredential(temp.db, userId(FRIEND));
    for (let index = 0; index < DEFAULT_THROTTLE_ADDRESS_CAPACITY; index += 1) {
      throttle.recordFailure(IP, `spray${String(index)}`);
    }
    const result = await attempt(basic(minted.username, minted.password));
    expect(result).toMatchObject({ ok: false, status: 429, reason: "throttled" });
    expect((result as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect(verified).toEqual([]);
  });

  it("3. challenges a request without credentials without charging the throttle", async () => {
    for (const header of [undefined, "", "Bearer abc", "Basic !!!", "Basic bm9jb2xvbg=="]) {
      const result = await attempt(header);
      expect(result, String(header)).toEqual({ ok: false, status: 401, reason: "no_credentials" });
    }
    expect(verified).toEqual([]);
    expect(failuresCharged()).toBe(0);
  });

  it("4. derives against the dummy hash for an unknown or malformed username", async () => {
    mintGitCredential(temp.db, userId(FRIEND));
    for (const name of ["abcdefghij", "intruder", "ABCDEFGHIJ", "", "a".repeat(200)]) {
      verified = [];
      const result = await attempt(basic(name, "whatever-password"));
      expect(result, name).toEqual({ ok: false, status: 401, reason: "bad_credentials" });
      expect(verified, name).toEqual([dummyGitPasswordHash()]);
    }
    expect(membership.calls).toEqual([]);
  });

  it("4. treats a revoked credential (username kept, hash gone) as unknown", async () => {
    const id = userId(FRIEND);
    const minted = mintGitCredential(temp.db, id);
    revokeGitPassword(temp.db, id);
    const result = await attempt(basic(minted.username, minted.password));
    expect(result).toEqual({ ok: false, status: 401, reason: "bad_credentials" });
    expect(verified).toEqual([dummyGitPasswordHash()]);
  });

  it("5. derives exactly once against the user's hash for a wrong password", async () => {
    const minted = mintGitCredential(temp.db, userId(FRIEND));
    const stored = findGitCredential(temp.db, minted.username)!.passwordHash;
    const result = await attempt(basic(minted.username, "not-the-password"));
    expect(result).toEqual({ ok: false, status: 401, reason: "bad_credentials" });
    expect(verified).toEqual([stored]);
    expect(failuresCharged()).toBe(1);
  });

  it("6. refuses a user without git, after the derivation, and charges the throttle", async () => {
    const id = userId(FRIEND);
    const minted = mintGitCredential(temp.db, id);
    // updateUser deletes the hash when git is taken away (users.ts), so the
    // permission is flipped underneath it: this pins the order check itself,
    // for a row where a hash somehow survived.
    const permissions = { ...requireUser(temp.db, id).permissions, git: false };
    temp.db.run("UPDATE users SET permissions = ? WHERE id = ?", JSON.stringify(permissions), id);
    const result = await attempt(basic(minted.username, minted.password));
    expect(result).toEqual({ ok: false, status: 401, reason: "not_permitted", userId: id });
    expect(verified).toHaveLength(1);
    expect(membership.calls).toEqual([]);
    expect(failuresCharged()).toBe(1);
  });

  it("6. refuses a removed user even if a hash somehow survived", async () => {
    const id = userId(FRIEND);
    const minted = mintGitCredential(temp.db, id);
    // Reconcile deletes the hash; this simulates a row where it did not.
    temp.db.run("UPDATE users SET removed_at = ? WHERE id = ?", Date.now(), id);
    const result = await attempt(basic(minted.username, minted.password));
    expect(result).toEqual({ ok: false, status: 401, reason: "not_permitted", userId: id });
    expect(verified).toHaveLength(1);
    expect(failuresCharged()).toBe(1);
  });

  it("7. refuses a non-member with the same 401", async () => {
    const id = userId(FRIEND);
    const minted = mintGitCredential(temp.db, id);
    membership.decide = () => Promise.resolve("not_member");
    const result = await attempt(basic(minted.username, minted.password));
    expect(result).toEqual({ ok: false, status: 401, reason: "not_member", userId: id });
    expect(membership.calls).toEqual([FRIEND]);
    expect(failuresCharged()).toBe(1);
  });

  it("7. fails closed with 503 when the policy cannot be read, without charging the throttle", async () => {
    const id = userId(FRIEND);
    const minted = mintGitCredential(temp.db, id);
    membership.decide = () => Promise.resolve("unavailable");
    const result = await attempt(basic(minted.username, minted.password));
    expect(result).toEqual({ ok: false, status: 503, reason: "policy_unavailable", userId: id });
    expect(failuresCharged()).toBe(0);
  });

  it("7. treats a membership read that throws as unavailable", async () => {
    const minted = mintGitCredential(temp.db, userId(FRIEND));
    membership.decide = () => Promise.reject(new Error("boom"));
    const result = await attempt(basic(minted.username, minted.password));
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it("7. exempts the admin from the membership rule", async () => {
    const admin = getAdminUser(temp.db);
    const minted = mintGitCredential(temp.db, admin.id);
    membership.decide = () => Promise.resolve("unavailable");
    const result = await attempt(basic(minted.username, minted.password));
    expect(result).toMatchObject({ ok: true, user: { id: admin.id, isAdmin: true } });
    expect(membership.calls).toEqual([]);
  });

  it("re-checks the credential after the membership await (a refresh removed the user)", async () => {
    const id = userId(FRIEND);
    const minted = mintGitCredential(temp.db, id);
    // A refresh during the membership read reconciles FRIEND out of the table
    // and deletes the hash; the copy it answered from still said allow.
    membership.decide = () => {
      reconcileUsers(temp.db, [OTHER]);
      return Promise.resolve("allow");
    };
    const result = await attempt(basic(minted.username, minted.password));
    expect(result).toEqual({ ok: false, status: 401, reason: "changed", userId: id });
  });

  it("re-checks the credential after the membership await (rotated meanwhile)", async () => {
    const id = userId(FRIEND);
    const minted = mintGitCredential(temp.db, id);
    membership.decide = () => {
      mintGitCredential(temp.db, id);
      return Promise.resolve("allow");
    };
    const result = await attempt(basic(minted.username, minted.password));
    expect(result).toMatchObject({ ok: false, status: 401, reason: "changed" });
  });

  it("accepts a member with a live credential and clears only that (address, username)", async () => {
    const id = userId(FRIEND);
    const minted = mintGitCredential(temp.db, id);
    throttle.recordFailure(IP, minted.username);
    throttle.recordFailure(IP, "someoneelse");
    const result = await attempt(basic(minted.username, minted.password));
    expect(result).toMatchObject({ ok: true, user: { id, email: FRIEND } });
    expect(membership.calls).toEqual([FRIEND]);
    // The address bucket and the other username's pair keep their charges: a
    // valid credential must not reset anyone else's guessing budget.
    expect(throttle.size).toBe(2);
    expect(failuresCharged()).toBe(2);
  });

  it("lets a user in from their known address after someone sprays it dry", async () => {
    const id = userId(FRIEND);
    const minted = mintGitCredential(temp.db, id);
    expect(await attempt(basic(minted.username, minted.password))).toMatchObject({ ok: true });
    for (let index = 0; index < DEFAULT_THROTTLE_ADDRESS_CAPACITY; index += 1) {
      const sprayed = await attempt(basic(`spray${String(index)}aa`, "wrong"));
      expect(sprayed).toMatchObject({ ok: false, status: 401 });
    }
    // A stranger at that address is throttled now...
    expect(await attempt(basic("strangerab", "wrong"))).toMatchObject({ status: 429 });
    // ...but the user who logged in from it before is not locked out.
    expect(await attempt(basic(minted.username, minted.password))).toMatchObject({
      ok: true,
      user: { id },
    });
  });

  it("does not let one user's password open another user's username", async () => {
    const friend = mintGitCredential(temp.db, userId(FRIEND));
    const other = mintGitCredential(temp.db, userId(OTHER));
    const result = await attempt(basic(other.username, friend.password));
    expect(result).toEqual({ ok: false, status: 401, reason: "bad_credentials" });
  });
});
