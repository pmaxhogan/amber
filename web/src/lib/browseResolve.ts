import { onBeforeUnmount, ref } from "vue";
import type { BrowseResolved } from "@amber/shared";
import { normalizeError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import { isNotFound } from "./browse.ts";

/**
 * Turns what a person typed (a branch, a tag, a short or full sha) into a
 * commit through the server, for the jump box and the ref picker's search box.
 * Call it from `setup`: it injects the api client and aborts on unmount.
 */
export function useRevResolver(
  repoId: () => number,
  onResolved: (resolved: BrowseResolved) => void,
) {
  const api = useApi();
  const busy = ref(false);
  /** Why the last attempt failed; empty when it did not, or once the text changes. */
  const message = ref("");

  let inflight: AbortController | null = null;

  async function submit(text: string): Promise<void> {
    const rev = text.trim();
    if (rev === "") return;
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    busy.value = true;
    message.value = "";
    try {
      const resolved = await api.browseResolve(repoId(), rev, controller.signal);
      onResolved(resolved);
    } catch (cause) {
      const error = normalizeError(cause);
      if (error.problem === "aborted") return;
      message.value = isNotFound(error) ? `"${rev}" is not in this backup.` : error.message;
    } finally {
      if (inflight === controller) {
        inflight = null;
        busy.value = false;
      }
    }
  }

  function clear(): void {
    message.value = "";
  }

  onBeforeUnmount(() => inflight?.abort());

  return { busy, message, submit, clear };
}
