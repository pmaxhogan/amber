import { externalHref, isNormalizedTreePath } from "./paths.ts";
import { TREE_PATH_ATTR } from "./render.ts";

/**
 * Puts a frame document (from buildFrameDocument) on the page.
 *
 * The frame is `sandbox="allow-same-origin"` and nothing else. No script can
 * run inside it, so the same origin is inert there; it is what lets this
 * parent code measure the content and handle clicks, and lets image requests
 * to the raw endpoint carry the session cookie. Never add `allow-scripts`:
 * together with `allow-same-origin` the frame could remove its own sandbox.
 *
 * All script runs here, in the parent. Everything read from the frame goes
 * through the platform prototypes rather than properties of the frame's
 * document, so a named element cannot shadow what we call (DOM clobbering).
 */

/** The exact sandbox token list. */
export const FRAME_SANDBOX = "allow-same-origin";
/**
 * The tallest the frame grows, in CSS pixels. Past this the document scrolls
 * inside the frame instead of making the page absurdly long.
 */
export const MAX_FRAME_HEIGHT = 20_000;
/** How often the parent looks for the parsed frame document before `load`. */
const EARLY_ATTACH_INTERVAL_MS = 50;

export interface MountFrameOptions {
  /** Accessible name of the frame. */
  title: string;
  /** A link to another path in the same tree was activated. */
  onNavigate: (path: string) => void;
  /** Opens an external link. Defaults to a `noopener,noreferrer` window.open. */
  openExternal?: (href: string) => void;
  /** The frame ended up somewhere other than its own srcdoc document. */
  onUnexpectedLocation?: () => void;
  /** Light or dark, so the browser paints the frame canvas to match. */
  colorScheme?: "light" | "dark";
  /**
   * Called after each load with whether the parent's listeners on the frame
   * document actually run. WebKit does not invoke them in a frame whose
   * sandbox forbids scripts, so there links are inert and the caller has to
   * offer them some other way.
   */
  onClickHandling?: (handled: boolean) => void;
}

export interface MountedFrame {
  iframe: HTMLIFrameElement;
  /** Re-measures the content height now. */
  measure: () => void;
  dispose: () => void;
}

const documentElementGetter = Object.getOwnPropertyDescriptor(
  Document.prototype,
  "documentElement",
)?.get;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const dispatch = EventTarget.prototype.dispatchEvent;
const closest = Element.prototype.closest;
const getAttribute = Element.prototype.getAttribute;
const getBoundingClientRect = Element.prototype.getBoundingClientRect;

function defaultOpenExternal(href: string): void {
  window.open(href, "_blank", "noopener,noreferrer");
}

/** The frame's current URL, or null when it cannot be read. */
function frameHref(win: Window | null): string | null {
  try {
    return win === null ? null : win.location.href;
  } catch {
    return null;
  }
}

/** The element a click landed on, or the parent element of a text node. */
function eventElement(event: Event): Element | null {
  let node = event.target as Node | null;
  if (node !== null && node.nodeType !== 1) node = node.parentNode;
  return node !== null && node.nodeType === 1 ? (node as Element) : null;
}

/**
 * Handles a click or auxclick inside the frame. A link never navigates the
 * frame: a tree link becomes `onNavigate`, an http(s) or mailto link opens in
 * a new window from the parent, and anything else does nothing. A click that
 * is not on a link is cancelled too, except on a `<summary>`, whose default
 * action is opening its `<details>`.
 */
export function handleFrameClick(
  event: MouseEvent,
  onNavigate: (path: string) => void,
  openExternal: (href: string) => void,
): void {
  const element = eventElement(event);
  const anchor = element === null ? null : (closest.call(element, "a") as Element | null);
  if (anchor === null) {
    if (element !== null && closest.call(element, "summary") !== null && event.button === 0) return;
    event.preventDefault();
    return;
  }
  event.preventDefault();
  // Only the primary button and the middle button follow a link.
  if (event.button !== 0 && event.button !== 1) return;
  const treePath = getAttribute.call(anchor, TREE_PATH_ATTR);
  if (treePath !== null) {
    if (isNormalizedTreePath(treePath)) onNavigate(treePath);
    return;
  }
  const href = externalHref(getAttribute.call(anchor, "href"));
  if (href !== null) openExternal(href);
}

/**
 * Creates the iframe, sets its sandbox before its content, and appends it to
 * `container`. Listeners are attached on every load of the frame document.
 */
export function mountMarkdownFrame(
  container: HTMLElement,
  documentHtml: string,
  options: MountFrameOptions,
): MountedFrame {
  const ownerDocument = container.ownerDocument;
  const iframe = ownerDocument.createElement("iframe");
  iframe.setAttribute("sandbox", FRAME_SANDBOX);
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("title", options.title);
  iframe.setAttribute("loading", "eager");
  iframe.style.display = "block";
  iframe.style.width = "100%";
  iframe.style.height = "0px";
  iframe.style.border = "0";
  if (options.colorScheme !== undefined) iframe.style.colorScheme = options.colorScheme;
  iframe.setAttribute("srcdoc", documentHtml);

  const openExternal = options.openExternal ?? defaultOpenExternal;
  let cleanup: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let disposed = false;
  let blanked = false;
  let attachedTo: Document | null = null;
  let earlyTimer: ReturnType<typeof setInterval> | null = null;

  function frameRoot(): Element | null {
    const doc = iframe.contentDocument;
    if (doc === null || documentElementGetter === undefined) return null;
    return (documentElementGetter.call(doc) as Element | null) ?? null;
  }

  function measure(): void {
    if (disposed) return;
    const root = frameRoot();
    if (root === null) return;
    const height = Math.ceil(getBoundingClientRect.call(root).height);
    if (Number.isFinite(height) && height >= 0) {
      iframe.style.height = `${Math.min(height, MAX_FRAME_HEIGHT)}px`;
    }
  }

  function detach(): void {
    cleanup?.();
    cleanup = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    attachedTo = null;
  }

  function stopEarlyAttach(): void {
    if (earlyTimer !== null) clearInterval(earlyTimer);
    earlyTimer = null;
  }

  /**
   * `load` waits for every image. Once the srcdoc document is parsed the
   * parent can already measure it and take its clicks, so it looks for that
   * document on a short timer until `load`.
   */
  function tryEarlyAttach(): void {
    if (disposed || blanked) {
      stopEarlyAttach();
      return;
    }
    const doc = iframe.contentDocument;
    if (doc === null || frameHref(iframe.contentWindow) !== "about:srcdoc") return;
    if (doc.readyState === "loading") return;
    stopEarlyAttach();
    if (attachedTo !== doc) attach(doc);
  }

  function onLoad(): void {
    stopEarlyAttach();
    if (disposed || blanked) {
      detach();
      return;
    }
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (doc !== null && doc === attachedTo && frameHref(win) === "about:srcdoc") {
      measure();
      return;
    }
    detach();
    if (doc === null || frameHref(win) !== "about:srcdoc") {
      // Something navigated the frame away from its own document. Blank it
      // once and hand over to the caller; later loads (the blank page) are
      // not reported again.
      blanked = true;
      iframe.removeAttribute("srcdoc");
      iframe.style.height = "0px";
      options.onUnexpectedLocation?.();
      return;
    }
    attach(doc);
  }

  function attach(doc: Document): void {
    detach();
    attachedTo = doc;
    const onClick = (event: Event): void =>
      handleFrameClick(event as MouseEvent, options.onNavigate, openExternal);
    const onAnyLoad = (): void => measure();
    addListener.call(doc, "click", onClick, true);
    addListener.call(doc, "auxclick", onClick, true);
    // Image loads and details toggles do not bubble, but they do pass the
    // document in the capture phase.
    addListener.call(doc, "load", onAnyLoad, true);
    addListener.call(doc, "error", onAnyLoad, true);
    addListener.call(doc, "toggle", onAnyLoad, true);
    cleanup = () => {
      removeListener.call(doc, "click", onClick, true);
      removeListener.call(doc, "auxclick", onClick, true);
      removeListener.call(doc, "load", onAnyLoad, true);
      removeListener.call(doc, "error", onAnyLoad, true);
      removeListener.call(doc, "toggle", onAnyLoad, true);
    };
    // A synthetic event tells whether this browser runs our listeners on a
    // document that may not run script of its own.
    let probed = false;
    const onProbe = (): void => {
      probed = true;
    };
    addListener.call(doc, "amber-probe", onProbe);
    dispatch.call(doc, new Event("amber-probe"));
    removeListener.call(doc, "amber-probe", onProbe);
    options.onClickHandling?.(probed);

    const root = frameRoot();
    if (root !== null && typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => measure());
      resizeObserver.observe(root);
    }
    measure();
  }

  const onWindowResize = (): void => measure();
  iframe.addEventListener("load", onLoad);
  ownerDocument.defaultView?.addEventListener("resize", onWindowResize);
  container.appendChild(iframe);
  earlyTimer = setInterval(tryEarlyAttach, EARLY_ATTACH_INTERVAL_MS);

  return {
    iframe,
    measure,
    dispose(): void {
      disposed = true;
      stopEarlyAttach();
      detach();
      iframe.removeEventListener("load", onLoad);
      ownerDocument.defaultView?.removeEventListener("resize", onWindowResize);
      iframe.remove();
    },
  };
}
