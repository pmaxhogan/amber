import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import App from "../src/App.vue";
import InsecureBanner from "../src/components/InsecureBanner.vue";
import { routes } from "../src/router/index.ts";
import { mountGlobals } from "./helpers/mount.ts";
import { flush } from "./helpers/dom.ts";
import { makeStatus, stubApi } from "./helpers/stubApi.ts";

async function mountApp(insecureMode: boolean) {
  const api = stubApi({
    status: vi.fn().mockResolvedValue(makeStatus({ insecureMode })),
  } as never);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push("/about");
  await router.isReady();
  const wrapper = mount(App, { global: mountGlobals({ api, router }) });
  await flush();
  return wrapper;
}

describe("insecure mode banner", () => {
  it("is absent when authentication is enforced", async () => {
    const wrapper = await mountApp(false);
    expect(wrapper.findComponent(InsecureBanner).exists()).toBe(false);
  });

  it("appears at the very top when the server reports insecure mode", async () => {
    const wrapper = await mountApp(true);

    const banner = wrapper.findComponent(InsecureBanner);
    expect(banner.exists()).toBe(true);
    // First child of the shell: nothing renders above it.
    expect(wrapper.find(".amber-shell").element.firstElementChild).toBe(banner.element);
  });

  it("carries the exact wording the architecture doc specifies", async () => {
    const wrapper = await mountApp(true);
    const text = wrapper.findComponent(InsecureBanner).text();

    expect(text).toContain("INSECURE MODE: authentication is disabled.");
    expect(text).toContain("This instance trusts all local traffic.");
  });

  it("is announced to assistive technology as an alert", () => {
    const wrapper = mount(InsecureBanner);

    expect(wrapper.attributes("role")).toBe("alert");
    expect(wrapper.attributes("aria-live")).toBe("assertive");
  });

  it("offers no way to dismiss it", () => {
    const wrapper = mount(InsecureBanner);

    // Undismissable by construction: there is no control to press.
    expect(wrapper.findAll("button")).toHaveLength(0);
    expect(wrapper.findAll("[aria-label*='close' i]")).toHaveLength(0);
  });

  it("uses ASCII only, so it renders the same in every terminal and client", () => {
    const wrapper = mount(InsecureBanner);
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(wrapper.text())).toBe(true);
  });
});
