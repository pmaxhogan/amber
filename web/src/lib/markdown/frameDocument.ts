import {
  ALLOWED_ATTR,
  ALLOWED_TAGS,
  BLOCKED_IMAGE_ATTR,
  EXTERNAL_LINK_REL,
  MarkdownRenderError,
  TREE_PATH_ATTR,
  isImageUrl,
  isSaneDimension,
  MAX_COLSPAN,
  MAX_ROWSPAN,
} from "./render.ts";
import { MarkdownBudgetError } from "./errors.ts";
import { DEFAULT_MARKDOWN_BUDGET, assertBodyWithinBudget, type MarkdownBudget } from "./budget.ts";
import { externalHref, isNormalizedTreePath } from "./paths.ts";
import { type FrameTheme, validatedTheme } from "./theme.ts";

/**
 * The `srcdoc` document the rendered markdown is shown in.
 *
 * Its head is fixed and built here: a Content-Security-Policy meta as the very
 * first element (a meta policy only covers what comes after it), a no-referrer
 * meta, `<base target="_blank">` so a click the parent somehow misses becomes a
 * popup the sandbox blocks rather than a navigation of the frame, and a
 * stylesheet made only of constants and validated color literals. Repository
 * content only ever lands in the body.
 *
 * The finished string is parsed again, the way the frame will parse it, and
 * checked against an allowlist of its own before it is used. Serializing a DOM
 * and parsing it back is where mutation XSS lives; this check is what makes a
 * mutation fail closed instead of reaching the frame.
 */

const ORIGIN_PATTERN =
  /^https?:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;

function assertOrigin(origin: string): void {
  if (!ORIGIN_PATTERN.test(origin)) {
    throw new MarkdownRenderError("the app origin is not a plain http(s) origin");
  }
}

function assertRepoId(repoId: number): void {
  if (!Number.isSafeInteger(repoId) || repoId <= 0) {
    throw new MarkdownRenderError("the repository id is not a positive integer");
  }
}

/**
 * The one URL images may load from: the raw endpoint of this repository. A
 * CSP source with a path and no trailing slash matches that path exactly, and
 * the query string is not part of the match.
 */
export function frameImageSource(origin: string, repoId: number): string {
  assertOrigin(origin);
  assertRepoId(repoId);
  return `${origin}/api/repos/${repoId}/browse/raw`;
}

export function frameContentSecurityPolicy(origin: string, repoId: number): string {
  return [
    "default-src 'none'",
    `img-src ${frameImageSource(origin, repoId)}`,
    "style-src 'unsafe-inline'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/** The frame stylesheet. Only constants and validated colors, never repository data. */
export function frameStylesheet(input: FrameTheme): string {
  const t = validatedTheme(input);
  return [
    `:root{color-scheme:${t.dark ? "dark" : "light"};}`,
    `html{margin:0;padding:0;overflow-x:hidden;overflow-y:auto;background:${t.background};color:${t.text};}`,
    "body{margin:0;padding:2px 4px 8px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
      "font-size:14px;line-height:1.6;overflow-wrap:anywhere;}",
    "body>:first-child{margin-top:0;}",
    "body>:last-child{margin-bottom:0;}",
    "h1,h2,h3,h4,h5,h6{margin:1.4em 0 0.6em;line-height:1.25;font-weight:600;}",
    `h1,h2{padding-bottom:0.3em;border-bottom:1px solid ${t.border};}`,
    "h1{font-size:1.9em;}h2{font-size:1.45em;}h3{font-size:1.2em;}h4{font-size:1em;}",
    `h5{font-size:0.9em;}h6{font-size:0.85em;color:${t.muted};}`,
    "p,ul,ol,dl,table,pre,blockquote,details{margin:0 0 1em;}",
    "ul,ol{padding-left:2em;}li+li{margin-top:0.25em;}",
    `a{color:${t.link};text-decoration:underline;text-underline-offset:2px;}`,
    "a:not([href]){color:inherit;text-decoration:none;}",
    "img{max-width:100%;height:auto;vertical-align:middle;}",
    `hr{height:0;border:0;border-top:1px solid ${t.border};margin:1.5em 0;}`,
    `blockquote{margin-left:0;padding:0 1em;color:${t.muted};border-left:4px solid ${t.border};}`,
    "code,kbd,pre{font-family:ui-monospace,'SFMono-Regular','Cascadia Mono',Menlo,monospace;font-size:0.9em;}",
    `code{padding:0.15em 0.35em;border-radius:4px;background:${t.codeBackground};}`,
    `pre{padding:12px 14px;overflow-x:auto;border-radius:6px;background:${t.codeBackground};` +
      "line-height:1.45;overflow-wrap:normal;}",
    "pre code{padding:0;background:transparent;white-space:pre;}",
    `kbd{padding:0.1em 0.4em;border:1px solid ${t.border};border-bottom-width:2px;border-radius:4px;}`,
    "table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;}",
    `th,td{padding:6px 12px;border:1px solid ${t.border};}`,
    "th{font-weight:600;}",
    "details>summary{cursor:pointer;}",
    "dt{font-weight:600;}dd{margin:0 0 0.5em 1.5em;}",
    `[${BLOCKED_IMAGE_ATTR}]{display:inline-block;padding:0 0.4em;border:1px dashed ${t.border};` +
      `border-radius:4px;color:${t.muted};font-size:0.85em;}`,
  ].join("\n");
}

export interface FrameDocumentOptions {
  /** Sanitized, rewritten body HTML from renderMarkdownBody. */
  bodyHtml: string;
  /** The app origin, e.g. `https://amber.example.com`. */
  origin: string;
  repoId: number;
  theme: FrameTheme;
  /** Work limits; defaults to DEFAULT_MARKDOWN_BUDGET. */
  budget?: MarkdownBudget;
  /** RenderResult.elementCount, for the reconstruction backstop. */
  expectedElements?: number;
}

/** Builds and checks the whole `srcdoc` string. Throws MarkdownRenderError. */
export function buildFrameDocument(options: FrameDocumentOptions): string {
  // The check below parses the whole document again; a body that grew past
  // the limit while being sanitized is refused before that parse.
  assertBodyWithinBudget(options.bodyHtml, options.budget ?? DEFAULT_MARKDOWN_BUDGET);
  const csp = frameContentSecurityPolicy(options.origin, options.repoId);
  const css = frameStylesheet(options.theme);
  const html =
    "<!DOCTYPE html><html><head>" +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<meta name="referrer" content="no-referrer">' +
    '<base target="_blank">' +
    `<style>${css}</style>` +
    `</head><body>${options.bodyHtml}</body></html>`;
  assertSafeFrameDocument(html, {
    csp,
    css,
    imageSource: frameImageSource(options.origin, options.repoId),
    appOrigin: options.origin,
    expectedElements: options.expectedElements,
  });
  return html;
}

export interface FrameDocumentExpectations {
  csp: string;
  css: string;
  imageSource: string;
  /** External links may not point here. */
  appOrigin: string;
  /** Elements in the body before serialization (RenderResult.elementCount). */
  expectedElements?: number;
}

/** The sanitizer's elements plus `<wbr>`, which only the rewrite pass adds. */
const BODY_TAGS = new Set([...ALLOWED_TAGS, "wbr"]);
const PLAIN_ATTRS = new Set(ALLOWED_ATTR.filter((name) => name !== "href" && name !== "src"));

function fail(reason: string): never {
  throw new MarkdownRenderError(`frame document check failed: ${reason}`);
}

/**
 * Parses `html` in an inert document, as the frame will, and checks every
 * node. The head must be exactly the four elements this module writes; the
 * body may hold only allowlisted elements whose URLs have the exact shapes
 * the rewrite pass produces.
 */
export function assertSafeFrameDocument(html: string, expect: FrameDocumentExpectations): void {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.documentElement;
  if (root.attributes.length !== 0) fail("attributes on <html>");
  const head = doc.head;
  const body = doc.body;
  if (head === null || body === null) fail("missing head or body");
  if (root.children.length !== 2) fail("unexpected children of <html>");
  if (body.attributes.length !== 0) fail("attributes on <body>");

  const headElements = Array.from(head.childNodes);
  if (headElements.length !== 4) fail("unexpected head contents");
  const [cspMeta, referrerMeta, base, style] = headElements as Element[];
  expectElement(cspMeta, "meta", { "http-equiv": "Content-Security-Policy", content: expect.csp });
  expectElement(referrerMeta, "meta", { name: "referrer", content: "no-referrer" });
  expectElement(base, "base", { target: "_blank" });
  expectElement(style, "style", {});
  if (style?.textContent !== expect.css) fail("stylesheet changed");

  const walker = doc.createTreeWalker(body, 0xffffffff);
  let elements = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType === 3) continue;
    if (node.nodeType !== 1) fail(`node type ${node.nodeType} in body`);
    checkBodyElement(node as Element, expect);
    elements += 1;
  }
  // The body was serialized from a tree of expectedElements elements. A parse
  // that builds many more means the parser re-created elements (the
  // formatting-element reconstruction that can take minutes), so the frame,
  // which would parse it again, never gets it.
  if (expect.expectedElements !== undefined && elements > expect.expectedElements * 2 + 16) {
    throw new MarkdownBudgetError(
      `frame document check failed: ${elements} elements parsed from ${expect.expectedElements}`,
    );
  }
}

function expectElement(
  node: Element | undefined,
  tag: string,
  attrs: Record<string, string>,
): void {
  if (node === undefined || node.nodeType !== 1 || node.localName !== tag) {
    fail(`expected <${tag}> in head`);
  }
  const names = Object.keys(attrs);
  if (node.attributes.length !== names.length) fail(`unexpected attributes on <${tag}>`);
  for (const name of names) {
    if (node.getAttribute(name) !== attrs[name]) fail(`attribute ${name} on <${tag}>`);
  }
}

function checkBodyElement(element: Element, expect: FrameDocumentExpectations): void {
  const tag = element.localName;
  if (element.namespaceURI !== "http://www.w3.org/1999/xhtml" || !BODY_TAGS.has(tag)) {
    fail(`element <${tag}>`);
  }
  if (tag === "wbr" && element.attributes.length !== 0) fail("attributes on <wbr>");
  for (const attr of Array.from(element.attributes)) {
    const name = attr.name;
    const value = attr.value;
    if (attr.namespaceURI !== null) fail(`namespaced attribute ${name}`);
    if (PLAIN_ATTRS.has(name)) {
      if ((name === "width" || name === "height") && !isSaneDimension(value)) fail(name);
      if (
        (name === "colspan" || name === "rowspan" || name === "start") &&
        !/^\d{1,5}$/.test(value)
      ) {
        fail(name);
      }
      if (name === "colspan" && (Number(value) > MAX_COLSPAN || Number(value) < 1)) fail(name);
      if (name === "rowspan" && (Number(value) > MAX_ROWSPAN || Number(value) < 1)) fail(name);
      continue;
    }
    if (tag === "a" && name === "href") {
      const treePath = element.getAttribute(TREE_PATH_ATTR);
      if (treePath !== null) {
        if (value !== "#") fail("tree link href");
      } else if (externalHref(value) !== value) {
        fail("external link href");
      } else if (new URL(value).origin === expect.appOrigin) {
        fail("absolute link to the app's own origin");
      }
      continue;
    }
    if (tag === "a" && name === TREE_PATH_ATTR) {
      if (!isNormalizedTreePath(value)) fail("tree path");
      continue;
    }
    if (tag === "a" && name === "target") {
      if (value !== "_blank") fail("link target");
      continue;
    }
    if (tag === "a" && name === "rel") {
      if (value !== EXTERNAL_LINK_REL) fail("link rel");
      continue;
    }
    if (tag === "img" && name === "src") {
      if (!isImageUrl(value, expect.imageSource)) fail("image src");
      continue;
    }
    if (tag === "span" && name === BLOCKED_IMAGE_ATTR) {
      if (value !== "") fail("placeholder marker");
      continue;
    }
    fail(`attribute ${name} on <${tag}>`);
  }
  // Every link, whatever it points at, carries target=_blank and our rel.
  if (
    tag === "a" &&
    (element.getAttribute("target") !== "_blank" ||
      element.getAttribute("rel") !== EXTERNAL_LINK_REL)
  ) {
    fail("link without target=_blank and rel");
  }
}
