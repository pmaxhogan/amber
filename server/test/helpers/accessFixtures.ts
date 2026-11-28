import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
} from "jose";
import { INSECURE_USER_HEADER } from "../../src/security/identity.ts";
import type { PolicyFetch, PolicyFetchResponse } from "../../src/security/accessPolicy.ts";
import type { CfAccessKeyGetter } from "../../src/security/cfAccess.ts";

/**
 * Fixtures for the identity path: locally signed Cloudflare Access tokens, a
 * policy fetcher that answers like the Cloudflare API without the network,
 * and a clock a test moves by hand. Shared so the git remote and the web
 * suites exercise the same seams as identity.test.ts.
 */

export const TEAM_DOMAIN = "amber-test.cloudflareaccess.com";
export const ISSUER = `https://${TEAM_DOMAIN}`;
export const AUD = "aud-0123456789abcdef";
export const ADMIN_EMAIL = "admin@example.com";
export const POLICY_ACCOUNT_ID = "acct-0123";
export const POLICY_ID = "policy-4567";
export const POLICY_TOKEN = "cf-api-token-do-not-leak";

/** Environment for a real (not insecure) app with the access policy configured. */
export function secureEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    INSECURE_ALLOW_PUBLIC_ACCESS: "0",
    CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    CF_ACCESS_AUD: AUD,
    AMBER_ADMIN_EMAIL: ADMIN_EMAIL,
    CF_API_TOKEN: POLICY_TOKEN,
    CF_ACCOUNT_ID: POLICY_ACCOUNT_ID,
    CF_ACCESS_POLICY_ID: POLICY_ID,
    ...overrides,
  };
}

export interface AccessKeys {
  getKey: CfAccessKeyGetter;
  privateKey: CryptoKey;
  /** Signs a token for `email` that verifies against getKey. */
  token(email: string, options?: { expiresIn?: string }): Promise<string>;
}

export async function createAccessKeys(): Promise<AccessKeys> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256" };
  const jwks: JSONWebKeySet = { keys: [jwk] };
  return {
    getKey: createLocalJWKSet(jwks),
    privateKey: pair.privateKey,
    token: (email, options = {}) =>
      new SignJWT({ sub: `sub-${email}`, email })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUD)
        .setExpirationTime(options.expiresIn ?? "5m")
        .sign(pair.privateKey),
  };
}

/** The request header that makes an insecure-mode request act as `email`. */
export function asUser(email: string): Record<string, string> {
  return { [INSECURE_USER_HEADER]: email };
}

/** A clock that only moves when told to. */
export class FakeClock {
  value: number;

  constructor(start = 1_800_000_000_000) {
    this.value = start;
  }

  readonly now = (): number => this.value;

  advance(ms: number): void {
    this.value += ms;
  }
}

/** A Cloudflare GET policy body whose include rules are these emails, plus extra rules. */
export function policyBody(
  emails: readonly string[],
  extra: { include?: Record<string, unknown>[]; exclude?: Record<string, unknown>[] } = {},
): unknown {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      id: POLICY_ID,
      name: "Amber users",
      decision: "allow",
      include: [...emails.map((email) => ({ email: { email } })), ...(extra.include ?? [])],
      exclude: extra.exclude ?? [],
      require: [],
    },
  };
}

export type PolicyAnswer =
  | { kind: "ok"; body: unknown }
  | { kind: "status"; status: number }
  | { kind: "throw"; error: Error }
  /** Never answers until `release` is called (or the request is aborted). */
  | { kind: "hang" };

/**
 * A scripted policy endpoint. `answer` decides the next response; every call
 * is recorded with its URL and authorization header so a test can check what
 * was sent.
 */
export class FakePolicyEndpoint {
  answer: PolicyAnswer;
  readonly calls: { url: string; authorization: string | undefined; signal: AbortSignal }[] = [];
  #pending: (() => void)[] = [];

  constructor(emails: readonly string[] = []) {
    this.answer = { kind: "ok", body: policyBody(emails) };
  }

  members(emails: readonly string[], extra?: Parameters<typeof policyBody>[1]): void {
    this.answer = { kind: "ok", body: policyBody(emails, extra) };
  }

  fail(status = 500): void {
    this.answer = { kind: "status", status };
  }

  /** Lets every hung request answer with whatever `answer` says by then. */
  release(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const resume of pending) {
      resume();
    }
  }

  readonly fetch: PolicyFetch = async (url, init) => {
    this.calls.push({ url, authorization: init.headers["authorization"], signal: init.signal });
    if (this.answer.kind === "hang") {
      await new Promise<void>((resolve, reject) => {
        this.#pending.push(resolve);
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    const answer = this.answer;
    if (answer.kind === "throw") {
      throw answer.error;
    }
    if (answer.kind === "status") {
      return response(answer.status, { success: false, errors: [{ code: 10000 }] });
    }
    if (answer.kind === "hang") {
      return response(500, {});
    }
    return response(200, answer.body);
  };
}

function response(status: number, body: unknown): PolicyFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}
