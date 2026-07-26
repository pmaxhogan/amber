import { fetch as undiciFetch, MockAgent, type MockPool } from "undici";
import type { DiscoveryContext, ProviderFetch } from "../../src/providers/types.ts";

/**
 * HTTP test rig for the provider clients. The mock dispatcher is passed into
 * the provider through DiscoveryContext.fetch rather than installed globally,
 * so nothing leaks between test files and no process-wide state is mutated.
 */
export interface MockHttp {
  agent: MockAgent;
  fetch: ProviderFetch;
  pool: (origin: string) => MockPool;
  close: () => Promise<void>;
}

export function mockHttp(): MockHttp {
  const agent = new MockAgent();
  agent.disableNetConnect();

  const fetchImpl = ((url: string, init?: RequestInit) =>
    undiciFetch(url, { ...init, dispatcher: agent } as never)) as unknown as ProviderFetch;

  return {
    agent,
    fetch: fetchImpl,
    pool: (origin: string) => agent.get(origin),
    close: async () => {
      await agent.close();
    },
  };
}

export function context(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
  return {
    baseUrl: "https://github.com",
    username: "octocat",
    token: null,
    visibility: "all",
    ...overrides,
  };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

export const JSON_HEADERS = { "content-type": "application/json" };
