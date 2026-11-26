import type { BrowserContext, Page } from "@playwright/test";

/**
 * Detectors for "hostile content ran" or "hostile content reached out",
 * registered on a context before any navigation. Everything is recorded as a
 * string in `events`; a clean run leaves it empty.
 *
 * - DIALOG: alert, confirm, prompt or beforeunload on any page.
 * - CANARY: a payload called `window.__pwn` (or `top.__pwn`). The binding is
 *   exposed on the context, so it exists in every frame and every popup; an
 *   init script also defines a console-reporting fallback in each document.
 * - REQUEST: an http(s) request to anything but the app's own origin. These
 *   are aborted at the context, so nothing leaves the machine.
 * - FRAMENAV: a non-main frame whose URL is anything but `about:srcdoc`.
 * - NEWPAGE / POPUP-WITH-OPENER: a window opened that the test did not open
 *   for a link it clicked itself, or one that kept a reference to its opener.
 */

export interface Detectors {
  events: string[];
  /** The next window that opens is expected (the test clicked an http(s) or mailto link). */
  allowPopups: (allow: boolean) => void;
  /** Open a page the test itself wants, without it counting as a popup. */
  newTestPage: () => Promise<Page>;
  clear: () => void;
}

/**
 * Defined in every document: a console-reporting canary for frames where the
 * binding is missing, and a window.open wrapper that reports whether the
 * caller kept a handle on the window it opened. Playwright's own opener()
 * cannot tell: it reports an opener for noopener windows too.
 */
const INIT_SCRIPT = `
  if (typeof window.__pwn !== "function") {
    window.__pwn = function () { console.error("__PWN_CANARY__"); };
  }
  (function () {
    var open = window.open;
    window.open = function (url, target, features) {
      var result = open.apply(this, arguments);
      try {
        if (typeof window.__amberOpen === "function") {
          window.__amberOpen(String(url), String(features || ""), result === null);
        }
      } catch (error) {}
      return result;
    };
  })();
`;

export async function armDetectors(
  context: BrowserContext,
  pages: Page[],
  appOrigin: string,
): Promise<Detectors> {
  const events: string[] = [];
  let popupsAllowed = false;
  let selfOpening = 0;
  const allowedPopups = new Set<Page>();
  const watched = new Set<Page>();
  const ownPages = new Set<Page>(pages);

  await context.exposeFunction("__pwn", () => {
    events.push("CANARY");
  });
  await context.exposeFunction(
    "__amberOpen",
    (url: string, features: string, returnedNull: boolean) => {
      // A window opened for a clicked link must be cut loose from its opener.
      if (!returnedNull || !/noopener/.test(features)) events.push(`POPUP-WITH-OPENER ${url}`);
    },
  );
  await context.addInitScript(INIT_SCRIPT);

  await context.route(
    (url) => /^https?:$/.test(url.protocol) && url.origin !== appOrigin,
    (route) => route.abort("blockedbyclient"),
  );

  context.on("request", (request) => {
    let page: Page | null;
    try {
      page = request.frame().page();
    } catch {
      page = null;
    }
    if (page !== null && allowedPopups.has(page)) return;
    // A window the test's own click just opened navigates before it is registered.
    if (popupsAllowed && (page === null || !ownPages.has(page))) return;
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (/^https?:$/.test(url.protocol) && url.origin !== appOrigin) {
      events.push(`REQUEST ${request.url()}`);
    }
  });

  function watch(page: Page): void {
    if (watched.has(page)) return;
    watched.add(page);
    page.on("dialog", (dialog) => {
      events.push(`DIALOG ${dialog.type()} ${dialog.message()}`);
      dialog.dismiss().catch(() => undefined);
    });
    page.on("console", (message) => {
      if (message.text().includes("__PWN_CANARY__")) events.push("CANARY (fallback)");
    });
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame() && frame.url() !== "about:srcdoc") {
        events.push(`FRAMENAV ${frame.url()}`);
      }
    });
  }

  for (const page of pages) watch(page);

  context.on("page", (page) => {
    if (selfOpening > 0) {
      watch(page);
      return;
    }
    if (!popupsAllowed) {
      events.push(`NEWPAGE ${page.url()}`);
      watch(page);
      return;
    }
    allowedPopups.add(page);
    watch(page);
  });

  return {
    events,
    allowPopups: (allow) => {
      popupsAllowed = allow;
    },
    newTestPage: async () => {
      selfOpening += 1;
      try {
        const page = await context.newPage();
        ownPages.add(page);
        watch(page);
        return page;
      } finally {
        selfOpening -= 1;
      }
    },
    clear: () => {
      events.length = 0;
    },
  };
}
