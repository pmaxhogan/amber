import { connect } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { INSECURE_USER_HEADER } from "../src/security/identity.ts";
import {
  createAccessKeys,
  secureEnv,
  FakePolicyEndpoint,
  type AccessKeys,
} from "./helpers/accessFixtures.ts";
import { createTempApp, type TempApp } from "./helpers.ts";

/**
 * Request targets light-my-request cannot express (it normalizes the url
 * before the app sees it), sent byte for byte over a real socket.
 */

let temp: TempApp | undefined;
let keys: AccessKeys;

beforeAll(async () => {
  keys = await createAccessKeys();
});

afterEach(async () => {
  await temp?.close();
  temp = undefined;
});

/** Send one raw HTTP/1.1 request and return the status code of the answer. */
async function rawStatus(port: number, lines: readonly string[]): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(`${[...lines, "Host: 127.0.0.1", "Connection: close"].join("\r\n")}\r\n\r\n`);
    });
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (match === null) {
        reject(new Error(`no status line in ${JSON.stringify(data.slice(0, 80))}`));
        return;
      }
      resolve(Number(match[1]));
    });
  });
}

async function listen(app: TempApp): Promise<number> {
  await app.app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  return address.port;
}

describe("a # in the request target", () => {
  it("is refused with 400 before the token check, so /git#x cannot pose as /git", async () => {
    temp = await createTempApp(secureEnv(), {
      cfAccessGetKey: keys.getKey,
      accessPolicyFetch: new FakePolicyEndpoint([]).fetch,
    });
    const port = await listen(temp);
    for (const target of ["/git#x", "/git/#/api/users", "/api/users#", "/#frag", "/healthz#x"]) {
      expect(await rawStatus(port, [`GET ${target} HTTP/1.1`])).toBe(400);
    }
    // Control: the same paths without the fragment still behave as before.
    expect(await rawStatus(port, ["GET /api/users HTTP/1.1"])).toBe(401);
    expect(await rawStatus(port, ["GET /healthz HTTP/1.1"])).toBe(200);
  });
});

describe("an absolute-form request line", () => {
  it("is still subject to the route's permission check", async () => {
    temp = await createTempApp({ INSECURE_USER_EMAILS: "friend@example.com" });
    const port = await listen(temp);
    const asFriend = `${INSECURE_USER_HEADER}: friend@example.com`;
    // GET /api/users is admin only. Spelled absolute-form it must not slip
    // past the check because its raw url does not start with /api.
    expect(await rawStatus(port, ["GET http://x/api/users HTTP/1.1", asFriend])).toBe(403);
    expect(await rawStatus(port, ["GET /api/users HTTP/1.1", asFriend])).toBe(403);
    // Control: the admin (the insecure-mode default) is let through either way.
    expect(await rawStatus(port, ["GET http://x/api/users HTTP/1.1"])).toBe(200);
  });
});
