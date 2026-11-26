import { createServer } from "node:net";
import { test as base } from "@playwright/test";
import { HOSTILE, buildHostileRepo, type HostileBuild } from "./hostileRepo.ts";
import {
  RICH,
  SINGLE,
  buildRichRepo,
  buildSingleRepo,
  startLocalGitServer,
  type LocalGitServer,
} from "./localGitServer.ts";

export interface ImportedRepo {
  id: number;
  displayName: string;
}

export interface BrowseFixtures {
  rich: ImportedRepo & { firstSha: string };
  single: ImportedRepo;
}

export interface HostileFixture extends ImportedRepo, HostileBuild {
  /** A loopback port nothing listens on: payloads aim at it, and no request may reach it. */
  deadPort: number;
}

/** A port that was free a moment ago, handed to payloads as "nobody listens here". */
async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done, fail) => {
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", done);
  });
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

interface Row {
  id: number;
  path: string;
  displayName: string;
  lastSuccessAt: number | null;
  lastError: string | null;
}

/** Same default as playwright.config.ts; the config's baseURL is not visible to a worker fixture. */
const baseUrl =
  process.env.AMBER_E2E_BASE_URL ??
  `http://127.0.0.1:${String(process.env.AMBER_E2E_PORT ?? 8099)}`;

async function listRows(): Promise<Row[]> {
  const response = await fetch(`${baseUrl}/api/repos?perPage=200`);
  if (!response.ok) throw new Error(`GET /api/repos failed with ${String(response.status)}`);
  return ((await response.json()) as { rows: Row[] }).rows;
}

async function importAndSync(server: LocalGitServer, names: string[]): Promise<Row[]> {
  const text = names.map((name) => server.urlFor(name)).join("\n");
  const response = await fetch(`${baseUrl}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`POST /api/import failed with ${String(response.status)}`);
  }
  const deadline = Date.now() + 90_000;
  let found: Row[] = [];
  while (Date.now() < deadline) {
    const rows = await listRows();
    // The forge is the loopback host and the path is `t/<name>`. A restarted
    // worker serves the same names from a new port, so take the newest row.
    found = names.map(
      (name) =>
        rows.filter((row) => row.path === `t/${name}`).sort((a, b) => b.id - a.id)[0] as Row,
    );
    const failed = found.find((row) => row?.lastError);
    if (failed) throw new Error(`${failed.path} failed to sync: ${failed.lastError ?? ""}`);
    if (found.every((row) => row?.lastSuccessAt != null)) return found;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`fixture repositories did not finish their first sync: ${JSON.stringify(found)}`);
}

/**
 * Two repositories built locally and imported once per worker: a rich one and
 * a single-branch one. No network beyond loopback.
 */
export const test = base.extend<
  object,
  { browseRepos: BrowseFixtures; hostileRepo: HostileFixture }
>({
  browseRepos: [
    // Playwright needs the destructuring pattern even with no dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startLocalGitServer();
      try {
        let firstSha = "";
        await server.addRepo(RICH.name, async (work) => {
          firstSha = (await buildRichRepo(work)).firstSha;
        });
        await server.addRepo(SINGLE.name, buildSingleRepo);
        const [rich, single] = await importAndSync(server, [RICH.name, SINGLE.name]);
        await use({
          rich: { id: rich!.id, displayName: rich!.displayName, firstSha },
          single: { id: single!.id, displayName: single!.displayName },
        });
      } finally {
        await server.close();
      }
    },
    { scope: "worker", timeout: 120_000 },
  ],
  hostileRepo: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startLocalGitServer();
      try {
        const deadPort = await unusedPort();
        let build: HostileBuild | undefined;
        await server.addRepo(HOSTILE.name, async (work) => {
          build = await buildHostileRepo(work, deadPort);
        });
        const [row] = await importAndSync(server, [HOSTILE.name]);
        await use({ id: row!.id, displayName: row!.displayName, deadPort, ...build! });
      } finally {
        await server.close();
      }
    },
    { scope: "worker", timeout: 120_000 },
  ],
});

export { expect } from "@playwright/test";
