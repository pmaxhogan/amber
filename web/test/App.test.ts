import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import App from "../src/App.vue";
import { NAV_LINKS, routes } from "../src/router/index.ts";

async function mountApp() {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push("/");
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [router] } });
  return { wrapper, router };
}

describe("App shell", () => {
  it("renders the app name in the header", async () => {
    const { wrapper } = await mountApp();
    expect(wrapper.find(".amber-brand").text()).toContain("Amber");
  });

  it("renders one nav link per registered page", async () => {
    const { wrapper } = await mountApp();
    const links = wrapper.findAll(".amber-nav a");
    expect(links).toHaveLength(NAV_LINKS.length);
    expect(links.map((link) => link.text())).toEqual(NAV_LINKS.map((link) => link.label));
  });

  it("renders the Repos page at the default route", async () => {
    const { wrapper } = await mountApp();
    expect(wrapper.find(".amber-main h1").text()).toBe("Repos");
  });

  it("swaps the routed view when navigating", async () => {
    const { wrapper, router } = await mountApp();
    await router.push("/import");
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".amber-main h1").text()).toBe("Import");
  });
});
