import { mount } from "@vue/test-utils";
import type { ApiClient } from "../../src/api/client.ts";
import RepoBrowser from "../../src/components/browse/RepoBrowser.vue";
import { mountGlobals } from "./mount.ts";
import { flush } from "./dom.ts";
import { makeRepo } from "./stubApi.ts";

/** The whole Browse tab, mounted against a stubbed api and settled. */
export async function mountBrowser(
  api: ApiClient,
  repo = makeRepo({ id: 1, displayName: "node" }),
) {
  const wrapper = mount(RepoBrowser, {
    props: { repo },
    global: mountGlobals({ api }),
    attachTo: document.body,
  });
  await flush();
  return wrapper;
}

/** Clicks the first button whose text is exactly `label`, then settles. */
export async function press(
  wrapper: Awaited<ReturnType<typeof mountBrowser>>,
  label: string,
): Promise<void> {
  const button = wrapper.findAll("button").find((candidate) => candidate.text().trim() === label);
  if (button === undefined) {
    throw new Error(
      `No button "${label}". Found: ${wrapper
        .findAll("button")
        .map((b) => b.text().trim())
        .join(" | ")}`,
    );
  }
  await button.trigger("click");
  await flush();
}

/** Opens a row of the file list by the name it shows. */
export async function openEntry(
  wrapper: Awaited<ReturnType<typeof mountBrowser>>,
  name: string,
): Promise<void> {
  const row = wrapper
    .findAll("button.file-list__row")
    .find((candidate) => candidate.find(".file-list__name").text() === name);
  if (row === undefined) throw new Error(`No file row "${name}"`);
  await row.trigger("click");
  await flush();
}
