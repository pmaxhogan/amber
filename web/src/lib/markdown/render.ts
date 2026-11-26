import createDOMPurify, { type Config } from "dompurify";
import MarkdownIt from "markdown-it";

type Markdown = InstanceType<typeof MarkdownIt>;
import {
  DEFAULT_MARKDOWN_BUDGET,
  assertHtmlWithinBudget,
  assertSourceWithinBudget,
  type MarkdownBudget,
} from "./budget.ts";
import { MarkdownBudgetError, MarkdownRenderError } from "./errors.ts";
import { classifyImage, classifyLink } from "./paths.ts";

/**
 * Markdown from a backed-up repository to sanitized body HTML.
 *
 * The input is hostile: amber backs up arbitrary repositories, and whoever
 * wrote one may expect a victim to view it here. Every layer below assumes the
 * one before it failed, and so does the sandboxed, script-less frame the
 * result is shown in (see frameDocument.ts and frame.ts).
 *
 * 1. markdown-it with no plugins. Raw HTML is on, because real READMEs lean on
 *    `<p align="center">`, `<img>`, `<details>` and `<table>`.
 * 2. DOMPurify with a short explicit allowlist, returning a DOM fragment that
 *    lives in DOMPurify's own inert document (no image ever loads there).
 * 3. A rewrite pass over that fragment: every link and image URL is replaced
 *    with one this code built, and anything unexpected aborts the render.
 *
 * Any failure throws MarkdownRenderError. Callers show the source as plain
 * text instead of anything partial.
 */

export { MarkdownBudgetError, MarkdownRenderError } from "./errors.ts";

/** Elements that survive the sanitizer. No SVG, MathML, forms, media or styles. */
export const ALLOWED_TAGS: readonly string[] = [
  "p",
  "div",
  "span",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "a",
  "img",
  "strong",
  "b",
  "em",
  "i",
  "del",
  "s",
  "sub",
  "sup",
  "kbd",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "details",
  "summary",
  "dl",
  "dt",
  "dd",
];

/**
 * The HTML formatting elements. The parser keeps them on its "list of active
 * formatting elements" and re-creates them whenever they are popped without
 * being closed, which hostile markup can turn into minutes of main-thread work
 * (each unclosed one re-created after every later block). They never reach
 * the parser under their own names: see standInFormattingTags.
 */
export const FORMATTING_TAGS: readonly string[] = [
  "a",
  "b",
  "big",
  "code",
  "em",
  "font",
  "i",
  "nobr",
  "s",
  "small",
  "strike",
  "strong",
  "tt",
  "u",
];

/** Prefix of the ordinary elements that stand in for formatting elements. */
export const STAND_IN_PREFIX = "amber-";

/** Stand-ins for the allowed formatting elements; renamed back after sanitizing. */
const STAND_IN_TAGS: readonly string[] = ALLOWED_TAGS.filter((tag) =>
  FORMATTING_TAGS.includes(tag),
).map((tag) => `${STAND_IN_PREFIX}${tag}`);

/**
 * A start or end tag of a formatting element, exactly as the HTML tokenizer
 * reads one: `<` or `</`, the name in any case, then whitespace, `/`, `>` or
 * the end of input. A tag name cannot continue past those characters, so no
 * formatting tag the browser would see escapes this pattern.
 */
const FORMATTING_TAG = new RegExp(
  `<(/?)(${FORMATTING_TAGS.join("|")})(?=[\\t\\n\\f\\r />]|$)`,
  "gi",
);

/**
 * Renames every formatting tag in an HTML string to an ordinary custom
 * element (`<b>` becomes `<amber-b>`). An ordinary element that is never
 * closed only nests, which the start-tag budget bounds, so the parse of
 * hostile markup stays near linear. After sanitizing, the rewrite pass
 * renames the allowed stand-ins back in the inert DOM, and the serialized
 * result is well formed. Also renames look-alikes inside attribute values or
 * comments, which only changes text nobody is shown as markup.
 */
export function standInFormattingTags(html: string): string {
  return html.replace(
    FORMATTING_TAG,
    (_match, slash: string, name: string) => `<${slash}${STAND_IN_PREFIX}${name.toLowerCase()}`,
  );
}

/** Attributes that survive the sanitizer, on any allowed element. */
export const ALLOWED_ATTR: readonly string[] = [
  "href",
  "src",
  "alt",
  "title",
  "align",
  "width",
  "height",
  "colspan",
  "rowspan",
  "start",
];

/**
 * The sanitizer config. Passed on every call, never through `setConfig`, and
 * no hooks: nothing global can loosen it. `ALLOW_DATA_ATTR` and
 * `ALLOW_ARIA_ATTR` default to true and bypass ALLOWED_ATTR, so both are off;
 * that is also what makes `data-amber-path` something only the rewrite pass
 * can create.
 */
const PURIFY_CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = {
  ALLOWED_TAGS: [...ALLOWED_TAGS, ...STAND_IN_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  ALLOW_SELF_CLOSE_IN_ATTR: false,
  ALLOWED_NAMESPACES: ["http://www.w3.org/1999/xhtml"],
  SAFE_FOR_XML: true,
  SANITIZE_DOM: true,
  SAFE_FOR_TEMPLATES: false,
  WHOLE_DOCUMENT: false,
  KEEP_CONTENT: true,
  RETURN_DOM_FRAGMENT: true,
};

/** The `rel` every kept external link carries. */
export const EXTERNAL_LINK_REL = "noopener noreferrer nofollow";
/** Set by the rewrite pass on a link into the same tree. */
export const TREE_PATH_ATTR = "data-amber-path";
/** Set by the rewrite pass on the text that stands in for a blocked image. */
export const BLOCKED_IMAGE_ATTR = "data-amber-blocked";

const ALIGN_VALUES = new Set(["left", "right", "center", "justify", "top", "middle", "bottom"]);
/** Largest `width` or `height` kept, in pixels; percentages are kept up to 100. */
export const MAX_DIMENSION = 2000;
/** Most images per document that become requests to the raw endpoint. */
export const MAX_TREE_IMAGES = 200;
const COUNT = /^\d{1,5}$/;
/** Largest `colspan` kept; larger values are clamped to it. */
export const MAX_COLSPAN = 20;
/** Largest `rowspan` kept; larger values are clamped to it. */
export const MAX_ROWSPAN = 50;

/** A `width` or `height` value within bounds: 0-2000 pixels or 0-100 percent. */
export function isSaneDimension(value: string): boolean {
  const match = /^(\d{1,5})(%?)$/.exec(value);
  if (match === null) return false;
  const number = Number(match[1]);
  return match[2] === "%" ? number <= 100 : number <= MAX_DIMENSION;
}

/** The subset of a DOMPurify instance this module uses; tests may swap it. */
export interface Sanitizer {
  isSupported: boolean;
  sanitize(dirty: string, cfg: Config & { RETURN_DOM_FRAGMENT: true }): DocumentFragment;
}

export interface RenderOptions {
  /** The markdown file's own path in the tree, normalized. */
  filePath: string;
  /** Builds the absolute raw-endpoint URL for an image at a tree path. */
  imageUrl: (path: string) => string;
  /**
   * The absolute URL, without query, that every image URL must sit at. Also
   * the frame's `img-src`, so the two cannot drift apart.
   */
  imageSource: string;
  /** Defaults to a private DOMPurify instance bound to `window`. */
  sanitizer?: Sanitizer;
  /** Work limits; defaults to DEFAULT_MARKDOWN_BUDGET. */
  budget?: MarkdownBudget;
}

let defaultSanitizer: Sanitizer | null = null;

function getDefaultSanitizer(): Sanitizer {
  if (defaultSanitizer === null) {
    // A private instance: hooks or config another module puts on the shared
    // default export cannot reach it.
    defaultSanitizer = createDOMPurify(window) as unknown as Sanitizer;
  }
  return defaultSanitizer;
}

function createMarkdown(): Markdown {
  const md = new MarkdownIt("default", {
    html: true,
    linkify: true,
    typographer: false,
    breaks: false,
    xhtmlOut: false,
  });
  // GFM tables mark column alignment with a `style` attribute, which the
  // sanitizer drops. Move it to the plain `align` attribute first.
  md.core.ruler.push("amber_table_align", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "th_open" && token.type !== "td_open") continue;
      const style = token.attrGet("style");
      if (style === null) continue;
      const match = /^text-align:(left|right|center)$/.exec(String(style));
      token.attrs = (token.attrs ?? []).filter(([name]) => name !== "style");
      if (match?.[1] !== undefined) token.attrSet("align", match[1]);
    }
    return true;
  });
  return md;
}

let markdown: Markdown | null = null;

/** Markdown to HTML with markdown-it alone. Exported for the layered browser checks. */
export function markdownToHtml(source: string): string {
  if (markdown === null) markdown = createMarkdown();
  return markdown.render(source);
}

/** A link the rewrite pass kept, with its visible text. */
export interface RenderedLink {
  text: string;
  target: { kind: "tree"; path: string } | { kind: "external"; href: string };
}

export interface RenderResult {
  /** Sanitized, rewritten body HTML for buildFrameDocument. */
  bodyHtml: string;
  /**
   * Every link that kept a target, in document order. The parent can offer
   * these itself where a browser does not deliver clicks from a script-less
   * frame to the parent's listeners.
   */
  links: RenderedLink[];
  /**
   * Elements in the body before it was serialized. buildFrameDocument
   * compares this with its own parse as a backstop against a body the parser
   * rebuilds into something much larger.
   */
  elementCount: number;
}

/**
 * Renders markdown to sanitized, rewritten body HTML. Throws
 * MarkdownRenderError on any failure; never returns something partial.
 */
export function renderMarkdown(source: string, options: RenderOptions): RenderResult {
  const sanitizer = options.sanitizer ?? getDefaultSanitizer();
  if (!sanitizer.isSupported) {
    throw new MarkdownRenderError("the HTML sanitizer is not supported in this browser");
  }
  const budget = options.budget ?? DEFAULT_MARKDOWN_BUDGET;
  assertSourceWithinBudget(source, budget);
  const html = standInFormattingTags(markdownToHtml(source));
  // Measured on the exact string the sanitizer parses, before any parse:
  // the browser's own HTML parser is where a hostile file can stall the tab.
  assertHtmlWithinBudget(html, budget);
  const fragment = sanitizer.sanitize(html, PURIFY_CONFIG);
  if (fragment === null || typeof fragment !== "object" || fragment.nodeType !== 11) {
    throw new MarkdownRenderError("the sanitizer did not return a document fragment");
  }
  const doc = fragment.ownerDocument;
  if (doc === null || doc === globalThis.document) {
    // Rewriting in the live document would start image requests before the
    // URLs are checked.
    throw new MarkdownRenderError("the sanitized fragment is not inert");
  }
  const links = rewriteFragment(fragment, options);
  const elementCount = fragment.querySelectorAll("*").length;
  const container = doc.createElement("div");
  container.append(fragment);
  return { bodyHtml: container.innerHTML, links, elementCount };
}

/** renderMarkdown without the link list. */
export function renderMarkdownBody(source: string, options: RenderOptions): string {
  return renderMarkdown(source, options).bodyHtml;
}

const MAX_LINK_TEXT = 200;

/**
 * Text that is safe to show outside the frame: controls, format characters
 * (bidi overrides and isolates, zero-width joiners and the like), private-use
 * and unassigned code points are removed, so a link cannot display its name
 * reversed or padded with invisible characters. Whitespace is collapsed.
 */
export function displayText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, "")
    .replace(/[\s\p{Z}]+/gu, " ")
    .trim();
}

function linkText(element: Element, target: RenderedLink["target"]): string {
  let text = displayText(element.textContent ?? "");
  if (text === "") {
    const alt = element.querySelector("img")?.getAttribute("alt") ?? "";
    text = displayText(alt);
  }
  if (text === "") text = target.kind === "tree" ? target.path || "/" : target.href;
  return text.length > MAX_LINK_TEXT ? `${text.slice(0, MAX_LINK_TEXT)}...` : text;
}

const ALLOWED_TAG_SET = new Set(ALLOWED_TAGS);
const ALLOWED_ATTR_SET = new Set(ALLOWED_ATTR);
const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Walks the sanitized fragment and replaces every URL with one this code
 * built. Anything the sanitizer should not have let through is an error, not
 * something to skip.
 */
export function rewriteFragment(
  fragment: DocumentFragment,
  options: RenderOptions,
): RenderedLink[] {
  const doc = fragment.ownerDocument;
  const kept: Array<{ element: Element; target: RenderedLink["target"] }> = [];
  const state = { treeImages: 0, appOrigin: new URL(options.imageSource).origin };
  // Comments carry nothing worth showing and are one more parser edge case.
  const comments: Node[] = [];
  const walker = doc.createTreeWalker(fragment, 0x80 /* NodeFilter.SHOW_COMMENT */);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) comments.push(node);
  for (const node of comments) node.parentNode?.removeChild(node);
  restoreFormattingTags(fragment);

  for (const element of Array.from(fragment.querySelectorAll("*"))) {
    const tag = element.localName;
    if (element.namespaceURI !== HTML_NS || !ALLOWED_TAG_SET.has(tag)) {
      throw new MarkdownRenderError(`unexpected element <${tag}> after sanitizing`);
    }
    for (const attr of Array.from(element.attributes)) {
      if (attr.namespaceURI !== null || !ALLOWED_ATTR_SET.has(attr.name)) {
        throw new MarkdownRenderError(`unexpected attribute ${attr.name} after sanitizing`);
      }
    }
    cleanPlainAttributes(element);
    if (tag === "a") {
      const target = rewriteLink(element, options, state.appOrigin);
      if (target !== null) kept.push({ element, target });
    } else if (tag === "img") rewriteImage(element, options, state);
    else {
      element.removeAttribute("href");
      element.removeAttribute("src");
    }
  }
  checkTables(fragment, options.budget ?? DEFAULT_MARKDOWN_BUDGET);
  breakLongRuns(fragment);
  // Text is read last, once images inside links have become placeholders.
  return kept.map(({ element, target }) => ({ text: linkText(element, target), target }));
}

/**
 * Allowed elements that are not phrasing content. A formatting element with
 * one of these inside it is what lets the frame's own parse pop the
 * formatting element early (a `<div>` closes an open `<p>` and everything in
 * it) and then re-create it before every later block.
 */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "details",
  "summary",
  "dl",
  "dt",
  "dd",
]);

/**
 * Renames the stand-ins back to the formatting elements they replaced, but
 * only where the whole subtree is phrasing content. The sanitizer can produce
 * trees the parser never would (removing a `<button>` hoists its `<div>`s
 * into an enclosing `<b>` inside a `<p>`), and a formatting element around
 * block content makes the frame's parse super-linear. Such a stand-in becomes
 * a plain `<span>` instead, keeping only its title; a link around blocks
 * loses its href. With formatting elements holding only phrasing content,
 * nothing in the serialized body can pop one before its own end tag, so
 * nothing is ever reconstructed. A link nested in another link is unwrapped
 * (the parser would split it). Linear: one reverse pass marks every element
 * with a block descendant.
 */
function restoreFormattingTags(fragment: DocumentFragment): void {
  const doc = fragment.ownerDocument;
  const all = Array.from(fragment.querySelectorAll("*"));
  const containsBlock = new Set<Element>();
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const element = all[index] as Element;
    const parent = element.parentElement;
    if (parent !== null && (BLOCK_TAGS.has(element.localName) || containsBlock.has(element))) {
      containsBlock.add(parent);
    }
  }
  const standIns = new Set(STAND_IN_TAGS);
  for (const standIn of all) {
    if (!standIns.has(standIn.localName)) continue;
    const phrasing = !containsBlock.has(standIn);
    const element = doc.createElement(
      phrasing ? standIn.localName.slice(STAND_IN_PREFIX.length) : "span",
    );
    for (const attr of Array.from(standIn.attributes)) {
      if (phrasing || attr.name === "title") element.setAttribute(attr.name, attr.value);
    }
    // One node at a time: spreading thousands of children into a single
    // call can exceed an engine's argument limit.
    while (standIn.firstChild !== null) element.appendChild(standIn.firstChild);
    standIn.replaceWith(element);
  }
  for (const link of nestedLinks(fragment)) {
    const parent = link.parentNode;
    if (parent === null) continue;
    while (link.firstChild !== null) parent.insertBefore(link.firstChild, link);
    parent.removeChild(link);
  }
}

/**
 * Visits every node under `root` in document order, telling whether it is
 * inside an element named `tag`. Iterative and linear, where `closest()` or a
 * descendant selector per node would be quadratic in a deeply nested tree.
 */
function visitTree(root: Node, tag: string, visit: (node: Node, inside: boolean) => void): void {
  const stack: Array<[Node, boolean]> = [];
  for (let child = root.lastChild; child !== null; child = child.previousSibling) {
    stack.push([child, false]);
  }
  while (stack.length > 0) {
    const [node, inside] = stack.pop() as [Node, boolean];
    visit(node, inside);
    const childInside = inside || (node.nodeType === 1 && (node as Element).localName === tag);
    for (let child = node.lastChild; child !== null; child = child.previousSibling) {
      stack.push([child, childInside]);
    }
  }
}

/** Links that sit inside another link, outermost first. */
function nestedLinks(fragment: DocumentFragment): Element[] {
  const found: Element[] = [];
  visitTree(fragment, "a", (node, insideLink) => {
    if (insideLink && node.nodeType === 1 && (node as Element).localName === "a") {
      found.push(node as Element);
    }
  });
  return found;
}

/** A run of non-space characters longer than this gets break opportunities. */
export const LONG_RUN = 200;
/** Spacing of the `<wbr>` elements added inside a long run. */
export const LONG_RUN_STEP = 80;
const ASCII_SPACE = /[ \t\n\r\f]/;

/**
 * Adds `<wbr>` break opportunities inside very long runs of text without
 * spaces. Chromium lays out a single run of a few hundred kilobytes with
 * punctuation in it (say `www.www.www...`) for seconds when it has to wrap;
 * with a break opportunity every 80 characters it takes milliseconds. Text in
 * `<pre>` does not wrap and is left alone.
 */
function breakLongRuns(fragment: DocumentFragment): void {
  const doc = fragment.ownerDocument;
  const texts: Text[] = [];
  visitTree(fragment, "pre", (node, insidePre) => {
    if (node.nodeType === 3 && !insidePre && (node as Text).data.length > LONG_RUN) {
      texts.push(node as Text);
    }
  });
  for (const text of texts) {
    const data = text.data;
    const pieces: Array<string | Element> = [];
    let start = 0;
    let run = 0;
    let due = false;
    let waited = 0;
    for (let i = 0; i < data.length; i += 1) {
      if (ASCII_SPACE.test(data[i] as string)) {
        run = 0;
        due = false;
        continue;
      }
      run += 1;
      if (run > LONG_RUN && run % LONG_RUN_STEP === 0) due = true;
      if (!due) continue;
      // Break only between whole characters, and give up waiting for a
      // pretty boundary after a while so a run of combining marks still
      // gets one; never inside a surrogate pair.
      const safe = isSafeBreak(data, i + 1);
      waited += 1;
      if (safe === "no" || (safe === "avoid" && waited < LONG_RUN_STEP)) continue;
      pieces.push(data.slice(start, i + 1), doc.createElement("wbr"));
      start = i + 1;
      due = false;
      waited = 0;
    }
    if (pieces.length === 0) continue;
    pieces.push(data.slice(start));
    const parent = text.parentNode;
    if (parent === null) continue;
    for (const piece of pieces) {
      parent.insertBefore(typeof piece === "string" ? doc.createTextNode(piece) : piece, text);
    }
    parent.removeChild(text);
  }
}

const MARK = /^(?:\p{M}|\u200d|[\ufe00-\ufe0f])$/u;

/**
 * Whether a break may go before `data[index]`: "no" inside a surrogate pair,
 * "avoid" before a combining mark, joiner, variation selector, emoji modifier
 * or tag character or right after a zero-width joiner, else "yes".
 */
export function isSafeBreak(data: string, index: number): "yes" | "avoid" | "no" {
  if (index <= 0 || index >= data.length) return "no";
  const before = data.charCodeAt(index - 1);
  const after = data.charCodeAt(index);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) return "no";
  if (before === 0x200d) return "avoid";
  const next = data.codePointAt(index) ?? 0;
  if (MARK.test(String.fromCodePoint(next))) return "avoid";
  if (next >= 0x1f3fb && next <= 0x1f3ff) return "avoid";
  if (next >= 0xe0000 && next <= 0xe01ef) return "avoid";
  return "yes";
}

/** Drops presentational attributes whose value is not a plain number or keyword. */
function cleanPlainAttributes(element: Element): void {
  const align = element.getAttribute("align");
  if (align !== null && !ALIGN_VALUES.has(align.toLowerCase())) element.removeAttribute("align");
  for (const name of ["width", "height"]) {
    const value = element.getAttribute(name);
    if (value !== null && !isSaneDimension(value)) element.removeAttribute(name);
  }
  for (const name of ["colspan", "rowspan", "start"]) {
    const value = element.getAttribute(name);
    if (value !== null && !COUNT.test(value)) element.removeAttribute(name);
  }
  // Huge spans make the table layout enormous (and crashed a renderer).
  for (const [name, max] of [
    ["colspan", MAX_COLSPAN],
    ["rowspan", MAX_ROWSPAN],
  ] as const) {
    const value = element.getAttribute(name);
    if (value === null) continue;
    // 0 means "to the end of the row group" for rowspan; neither needs it.
    if (Number(value) === 0) element.removeAttribute(name);
    else if (Number(value) > max) element.setAttribute(name, String(max));
  }
}

/**
 * Fails the render when the tables are too big to lay out quickly. Spans are
 * already clamped. Each table's grid is estimated by a sweep over its rows
 * that carries every rowspan forward: a row's width is its cells' colspans
 * plus the widths still spanning down from above, and the table's area is
 * its row count times its widest row (row groups are ignored, which can only
 * overestimate). Measured costs: Chromium lays out empty grid slots slowly
 * (40M slots, ~1 s) and WebKit overlapping rowspans (3.3M covered, ~1.8 s).
 */
function checkTables(fragment: DocumentFragment, budget: MarkdownBudget): void {
  const cells = fragment.querySelectorAll("td, th");
  if (cells.length > budget.maxTableCells) {
    throw new MarkdownBudgetError("the file's tables have too many cells to render");
  }
  // Rows grouped by table in one pass. A row's table is its parent or its
  // grandparent (through thead/tbody/tfoot); a row the sanitizer left
  // anywhere else is grouped under its parent. Asking each table for its own
  // rows would be quadratic for deeply nested tables.
  const tables = new Map<Node, Element[]>();
  for (const row of Array.from(fragment.querySelectorAll("tr"))) {
    const parent = row.parentElement;
    const grandparent = parent?.parentElement ?? null;
    const owner =
      parent !== null && parent.localName !== "table" && grandparent?.localName === "table"
        ? grandparent
        : (parent ?? fragment);
    const rows = tables.get(owner);
    if (rows === undefined) tables.set(owner, [row]);
    else rows.push(row);
  }
  let area = 0;
  for (const rows of tables.values()) {
    let active: Array<{ remaining: number; width: number }> = [];
    let widest = 0;
    for (const row of rows) {
      let width = active.reduce((sum, span) => sum + span.width, 0);
      const started: Array<{ remaining: number; width: number }> = [];
      for (const cell of Array.from(row.children)) {
        if (cell.localName !== "td" && cell.localName !== "th") continue;
        const colspan = Number(cell.getAttribute("colspan") ?? "1") || 1;
        const rowspan = Number(cell.getAttribute("rowspan") ?? "1") || 1;
        width += colspan;
        if (rowspan > 1) started.push({ remaining: rowspan - 1, width: colspan });
      }
      if (width > budget.maxRowColumns) {
        throw new MarkdownBudgetError("a table in the file is too wide to render");
      }
      widest = Math.max(widest, width);
      active = active
        .map((span) => ({ remaining: span.remaining - 1, width: span.width }))
        .filter((span) => span.remaining > 0)
        .concat(started);
    }
    area += rows.length * widest;
    if (area > budget.maxTableArea) {
      throw new MarkdownBudgetError("the file's tables are too large to render");
    }
  }
}

/**
 * Every link leaves with `target="_blank"` and our `rel`, whatever it points
 * at: in WebKit the parent's click listener never runs, and an explicit
 * `_blank` in a frame without `allow-popups` is what keeps a click from
 * navigating the frame. A link to the app's own origin is dropped: tree
 * navigation only ever comes from relative links, and an absolute same-origin
 * link could dress up any GET on the app (another repository's export, say).
 */
function rewriteLink(
  element: Element,
  options: RenderOptions,
  appOrigin: string,
): RenderedLink["target"] | null {
  const href = element.getAttribute("href");
  element.removeAttribute("href");
  element.removeAttribute(TREE_PATH_ATTR);
  element.removeAttribute("target");
  element.removeAttribute("rel");
  for (const name of ["src", "width", "height", "colspan", "rowspan", "start"]) {
    element.removeAttribute(name);
  }
  element.setAttribute("target", "_blank");
  element.setAttribute("rel", EXTERNAL_LINK_REL);
  const target = classifyLink(options.filePath, href, appOrigin);
  if (target.kind === "external") {
    element.setAttribute("href", target.href);
    return target;
  }
  if (target.kind === "tree") {
    element.setAttribute("href", "#");
    element.setAttribute(TREE_PATH_ATTR, target.path);
    return target;
  }
  return null;
}

function rewriteImage(
  element: Element,
  options: RenderOptions,
  state: { treeImages: number },
): void {
  const src = element.getAttribute("src");
  const target = classifyImage(options.filePath, src);
  // Each shown image is a request the server answers with git work, so a
  // document gets a bounded number; the rest become placeholders.
  if (target.kind === "tree" && state.treeImages < MAX_TREE_IMAGES) {
    state.treeImages += 1;
    const url = options.imageUrl(target.path);
    if (!isImageUrl(url, options.imageSource)) {
      throw new MarkdownRenderError("the image URL builder returned an unexpected URL");
    }
    element.setAttribute("src", url);
    for (const name of ["href", "colspan", "rowspan", "start"]) element.removeAttribute(name);
    return;
  }
  const alt = element.getAttribute("alt") ?? "";
  const placeholder = element.ownerDocument.createElement("span");
  placeholder.setAttribute(BLOCKED_IMAGE_ATTR, "");
  placeholder.setAttribute(
    "title",
    "Image not loaded: only images stored in this repository are shown",
  );
  placeholder.textContent = alt.trim() === "" ? "[image]" : `[image: ${alt.trim()}]`;
  element.replaceWith(placeholder);
}

/** An absolute URL at exactly `imageSource`, with a query and no fragment. */
export function isImageUrl(url: string, imageSource: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.href === url &&
    `${parsed.origin}${parsed.pathname}` === imageSource &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.hash === ""
  );
}
