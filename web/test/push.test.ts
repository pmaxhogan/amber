import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64UrlToBytes,
  disablePush,
  enablePush,
  pushSupported,
  readPushState,
} from "../src/lib/push.ts";
import { stubApi } from "./helpers/stubApi.ts";

/** A browser with a working push stack, as far as lib/push.ts can tell. */
function fakeBrowser(
  options: {
    permission?: NotificationPermission;
    ask?: NotificationPermission;
    existing?: boolean;
  } = {},
) {
  const subscription = {
    endpoint: "https://push.example/sub",
    toJSON: () => ({
      endpoint: "https://push.example/sub",
      keys: { p256dh: "pkey", auth: "akey" },
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  let current: typeof subscription | null = options.existing === true ? subscription : null;
  const pushManager = {
    getSubscription: vi.fn(() => Promise.resolve(current)),
    subscribe: vi.fn(() => {
      current = subscription;
      return Promise.resolve(subscription);
    }),
  };
  const registration = { pushManager };
  const serviceWorker = {
    register: vi.fn().mockResolvedValue(registration),
    getRegistration: vi.fn().mockResolvedValue(registration),
    ready: Promise.resolve(registration),
  };
  const notification = {
    permission: options.permission ?? "default",
    requestPermission: vi.fn().mockResolvedValue(options.ask ?? "granted"),
  };
  vi.stubGlobal("navigator", { serviceWorker, userAgent: "TestBrowser", maxTouchPoints: 0 });
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("PushManager", function PushManager() {});
  return { subscription, pushManager, serviceWorker, notification };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("base64UrlToBytes", () => {
  it("decodes url-safe base64 with the padding stripped", () => {
    expect([...base64UrlToBytes("AQID")]).toEqual([1, 2, 3]);
    expect([...base64UrlToBytes("-_8")]).toEqual([251, 255]);
    expect([...base64UrlToBytes("AQ")]).toEqual([1]);
  });
});

describe("readPushState", () => {
  it("is unsupported without a service worker", async () => {
    vi.stubGlobal("navigator", { userAgent: "Old", maxTouchPoints: 0 });
    expect(pushSupported()).toBe(false);
    expect(await readPushState(stubApi())).toBe("unsupported");
  });

  it("asks an iPhone that is not installed to the Home Screen to install first", async () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)",
      maxTouchPoints: 5,
    });
    expect(await readPushState(stubApi())).toBe("needs_install");
  });

  it("reports a blocked permission", async () => {
    fakeBrowser({ permission: "denied" });
    expect(await readPushState(stubApi())).toBe("denied");
  });

  it("is off when this browser has no subscription", async () => {
    fakeBrowser({ permission: "granted" });
    const api = stubApi();
    expect(await readPushState(api)).toBe("off");
    expect(api.subscribePush).not.toHaveBeenCalled();
  });

  it("re-announces an existing subscription so the server cannot lose it", async () => {
    fakeBrowser({ permission: "granted", existing: true });
    const api = stubApi();
    expect(await readPushState(api)).toBe("on");
    expect(api.subscribePush).toHaveBeenCalledWith({
      endpoint: "https://push.example/sub",
      keys: { p256dh: "pkey", auth: "akey" },
    });
  });
});

describe("enablePush", () => {
  it("asks permission, subscribes with the server key and saves the subscription", async () => {
    const browser = fakeBrowser();
    const api = stubApi({ getPush: vi.fn().mockResolvedValue({ publicKey: "AQID", devices: [] }) });

    expect(await enablePush(api)).toBe("on");

    expect(browser.serviceWorker.register).toHaveBeenCalledWith("/sw.js");
    const options = browser.pushManager.subscribe.mock.calls[0] as unknown as [
      { userVisibleOnly: boolean; applicationServerKey: Uint8Array },
    ];
    expect(options[0].userVisibleOnly).toBe(true);
    expect([...options[0].applicationServerKey]).toEqual([1, 2, 3]);
    expect(api.subscribePush).toHaveBeenCalledWith({
      endpoint: "https://push.example/sub",
      keys: { p256dh: "pkey", auth: "akey" },
    });
  });

  it("reuses a subscription the browser already has", async () => {
    const browser = fakeBrowser({ existing: true });
    const api = stubApi();
    expect(await enablePush(api)).toBe("on");
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.subscribePush).toHaveBeenCalledTimes(1);
  });

  it("stops when the user says no, without registering anything", async () => {
    const denied = fakeBrowser({ ask: "denied" });
    expect(await enablePush(stubApi())).toBe("denied");
    expect(denied.serviceWorker.register).not.toHaveBeenCalled();

    fakeBrowser({ ask: "default" });
    expect(await enablePush(stubApi())).toBe("off");
  });
});

describe("disablePush", () => {
  it("tells the server first, then drops the browser subscription", async () => {
    const browser = fakeBrowser({ existing: true });
    const api = stubApi();
    expect(await disablePush(api)).toBe("off");
    expect(api.unsubscribePush).toHaveBeenCalledWith("https://push.example/sub");
    expect(browser.subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when there is nothing to turn off", async () => {
    fakeBrowser();
    const api = stubApi();
    expect(await disablePush(api)).toBe("off");
    expect(api.unsubscribePush).not.toHaveBeenCalled();
  });
});
