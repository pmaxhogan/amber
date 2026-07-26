import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadToDirectory,
  fetchManifest,
  pickDirectory,
  saveBlob,
  supportsDirectoryPicker,
} from "../src/lib/folderDownload.ts";
import { stubApi } from "./helpers/stubApi.ts";
import type { ApiClient } from "../src/api/client.ts";
import type { TreeEntry } from "../src/api/types.ts";

function entry(path: string): TreeEntry {
  return { path, size: 10, mode: "100644", oid: `oid-${path}` };
}

interface FakeDirectory {
  name: string;
  files: Map<string, string>;
  children: Map<string, FakeDirectory>;
  /** Every file written anywhere below this handle, by full path. */
  tree: (prefix?: string) => Map<string, string>;
  getDirectoryHandle: (child: string) => Promise<FakeDirectory>;
  getFileHandle: (file: string) => Promise<{
    createWritable: () => Promise<{
      write: (blob: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
}

/** In-memory stand-in for a FileSystemDirectoryHandle. */
function fakeDirectory(name = "root"): FakeDirectory {
  const files = new Map<string, string>();
  const children = new Map<string, FakeDirectory>();

  const handle: FakeDirectory = {
    name,
    files,
    children,
    /** Every file written anywhere below this handle, by full path. */
    tree(prefix = ""): Map<string, string> {
      const out = new Map<string, string>();
      for (const [file, content] of files) out.set(`${prefix}${file}`, content);
      for (const [dir, child] of children) {
        for (const [file, content] of child.tree(`${prefix}${dir}/`)) out.set(file, content);
      }
      return out;
    },
    async getDirectoryHandle(child: string) {
      const existing = children.get(child) ?? fakeDirectory(child);
      children.set(child, existing);
      return existing;
    },
    async getFileHandle(file: string) {
      return {
        async createWritable() {
          return {
            async write(blob: Blob) {
              files.set(file, await blob.text());
            },
            async close() {},
          };
        },
      };
    },
  };
  return handle;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).showDirectoryPicker;
});

describe("supportsDirectoryPicker", () => {
  it("is false where the API is missing, which is every non-Chromium browser", () => {
    expect(supportsDirectoryPicker()).toBe(false);
  });

  it("is true once the picker exists", () => {
    (globalThis as Record<string, unknown>).showDirectoryPicker = () => Promise.resolve({});
    expect(supportsDirectoryPicker()).toBe(true);
  });
});

describe("pickDirectory", () => {
  it("returns null when the API is unavailable", async () => {
    await expect(pickDirectory()).resolves.toBeNull();
  });

  it("asks for readwrite access", async () => {
    const picker = vi.fn().mockResolvedValue({ name: "backups" });
    (globalThis as Record<string, unknown>).showDirectoryPicker = picker;

    await pickDirectory();

    expect(picker).toHaveBeenCalledWith({ mode: "readwrite" });
  });

  it("treats a dismissed picker as a non-event rather than an error", async () => {
    (globalThis as Record<string, unknown>).showDirectoryPicker = vi
      .fn()
      .mockRejectedValue(new Error("The user aborted a request."));

    await expect(pickDirectory()).resolves.toBeNull();
  });
});

describe("fetchManifest", () => {
  it("pages until the reported total is covered", async () => {
    const listTree = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [entry("a.txt"), entry("b.txt")],
        total: 3,
        page: 1,
        perPage: 200,
      })
      .mockResolvedValueOnce({ rows: [entry("c.txt")], total: 3, page: 2, perPage: 200 });
    const api = stubApi({ listTree } as never);

    const entries = await fetchManifest(api, 7);

    expect(listTree).toHaveBeenCalledTimes(2);
    expect(entries.map((row) => row.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("stops on a short page rather than looping forever", async () => {
    const listTree = vi.fn().mockResolvedValue({ rows: [], total: 99, page: 1, perPage: 200 });
    const api = stubApi({ listTree } as never);

    await expect(fetchManifest(api, 7)).resolves.toEqual([]);
    expect(listTree).toHaveBeenCalledTimes(1);
  });

  it("keeps every manifest row, because the server lists blobs only", async () => {
    const api = stubApi({
      listTree: vi.fn().mockResolvedValue({
        ref: "abc123",
        rows: [entry("src/index.ts"), entry("README.md")],
        total: 2,
        page: 1,
        perPage: 200,
      }),
    } as never);

    const entries = await fetchManifest(api, 7);

    expect(entries.map((row) => row.path)).toEqual(["src/index.ts", "README.md"]);
  });
});

describe("downloadToDirectory", () => {
  function apiReturning(contents: Record<string, string>): ApiClient {
    return stubApi({
      getBlob: vi.fn(async (_id: number, path: string) => new Blob([contents[path] ?? ""])),
    } as never);
  }

  it("writes every file into the picked directory", async () => {
    const directory = fakeDirectory();
    const api = apiReturning({ "README.md": "hello" });

    const result = await downloadToDirectory({
      api,
      repoId: 1,
      directory,
      entries: [entry("README.md")],
    });

    expect(result.written).toBe(1);
    expect(directory.tree().get("README.md")).toBe("hello");
  });

  it("creates the intermediate directories a nested path needs", async () => {
    const directory = fakeDirectory();
    const api = apiReturning({ "src/lib/format.ts": "export {}" });

    await downloadToDirectory({
      api,
      repoId: 1,
      directory,
      entries: [entry("src/lib/format.ts")],
    });

    expect(directory.tree().get("src/lib/format.ts")).toBe("export {}");
  });

  it("reports progress as it goes", async () => {
    const progress: { done: number; total: number; path: string }[] = [];
    await downloadToDirectory({
      api: apiReturning({}),
      repoId: 1,
      directory: fakeDirectory(),
      entries: [entry("a"), entry("b")],
      onProgress: (update) => progress.push({ ...update }),
    });

    expect(progress[0]).toEqual({ done: 0, total: 2, path: "a" });
    expect(progress[progress.length - 1]).toEqual({ done: 2, total: 2, path: "" });
  });

  it("keeps going after one file fails and reports which", async () => {
    const api = stubApi({
      getBlob: vi.fn(async (_id: number, path: string) => {
        if (path === "bad") throw new Error("blob is corrupt");
        return new Blob(["ok"]);
      }),
    } as never);
    const directory = fakeDirectory();

    const result = await downloadToDirectory({
      api,
      repoId: 1,
      directory,
      entries: [entry("bad"), entry("good")],
    });

    expect(result.written).toBe(1);
    expect(result.failed).toEqual([{ path: "bad", message: "blob is corrupt" }]);
    expect(directory.tree().has("good")).toBe(true);
  });

  it("stops early when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await downloadToDirectory({
      api: apiReturning({}),
      repoId: 1,
      directory: fakeDirectory(),
      entries: [entry("a"), entry("b")],
      signal: controller.signal,
    });

    expect(result.written).toBe(0);
  });
});

describe("saveBlob", () => {
  it("revokes the object URL it created", () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:fake");
    const revokeObjectURL = vi.fn();
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;

    try {
      saveBlob(new Blob(["x"]), "node-gitdir.zip");
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    } finally {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    }
  });
});
