import { BROWSE_MAX_PATH_CHARS, browseInlineImageType } from "@amber/shared";

/**
 * URL classification for links and images in repository markdown.
 *
 * Everything here is pure string work. Nothing is resolved against the app's
 * own URL: a relative reference is resolved against the markdown file's
 * directory inside the tree, and the only things that ever come out are a
 * normalized tree path or an absolute URL that `new URL` parsed and we
 * re-serialized.
 */

/** Schemes a link may keep. Compared exactly against `URL.protocol`. */
const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

/** C0 controls, space and DEL. A raw reference containing any of these is refused. */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000- \u007f]/;
/** C0 controls and DEL. A decoded tree path may hold spaces, never these. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Looks like `scheme:`. The `new URL` check catches the rest. */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

export type LinkTarget =
  { kind: "tree"; path: string } | { kind: "external"; href: string } | { kind: "none" };

export type ImageTarget = { kind: "tree"; path: string } | { kind: "blocked" };

/**
 * Checks that a tree path is already normalized: no leading or trailing
 * slash, no empty, `.` or `..` segment, no backslash or control character.
 * The empty string is the root of the tree.
 */
export function isNormalizedTreePath(path: string): boolean {
  if (path === "") return true;
  if (path.length > BROWSE_MAX_PATH_CHARS) return false;
  if (CONTROL.test(path) || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Resolves a relative reference against the directory of `filePath`.
 *
 * Returns the normalized tree path (no leading slash, `""` for the root), or
 * null for anything that is not a plain relative reference that stays inside
 * the tree: a scheme, `//host`, a leading `/`, a backslash, a control
 * character, a bad percent escape, or `..` past the root. The query and the
 * fragment are dropped.
 */
export function resolveTreeReference(filePath: string, reference: string): string | null {
  if (!isNormalizedTreePath(filePath) || filePath === "") {
    throw new Error("markdown file path is not a normalized tree path");
  }
  if (reference === "") return null;
  if (CONTROL_OR_SPACE.test(reference) || reference.includes("\\")) return null;
  if (reference.startsWith("/")) return null;
  if (SCHEME_PREFIX.test(reference) || parsesAsAbsolute(reference)) return null;

  const cut = reference.search(/[?#]/);
  const pathPart = cut === -1 ? reference : reference.slice(0, cut);
  if (pathPart === "") return null;

  const stack = filePath.split("/").slice(0, -1);
  for (const raw of pathPart.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    // A decoded separator or control character would let one segment become
    // several, or smuggle something past the checks above.
    if (segment.includes("/") || segment.includes("\\") || CONTROL.test(segment)) {
      return null;
    }
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }

  const resolved = stack.join("/");
  if (resolved.length > BROWSE_MAX_PATH_CHARS || !isNormalizedTreePath(resolved)) return null;
  return resolved;
}

function parsesAsAbsolute(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * An absolute http, https or mailto URL, re-serialized by the URL parser, or
 * null. The parser strips tabs and newlines, so `java\tscript:` is seen as
 * `javascript:` here and refused.
 */
export function externalHref(value: string | null): string | null {
  if (value === null || value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null;
}

/**
 * Where a link in the markdown may go. An absolute link to `appOrigin` (the
 * app's own origin) goes nowhere: in-tree navigation only comes from
 * relative links.
 */
export function classifyLink(
  filePath: string,
  href: string | null,
  appOrigin: string | null = null,
): LinkTarget {
  if (href === null || href === "") return { kind: "none" };
  const external = externalHref(href);
  if (external !== null) {
    if (appOrigin !== null && new URL(external).origin === appOrigin) return { kind: "none" };
    return { kind: "external", href: external };
  }
  // An in-page fragment has nothing to land on: headings carry no ids.
  if (href.startsWith("#")) return { kind: "none" };
  const path = resolveTreeReference(filePath, href);
  return path === null ? { kind: "none" } : { kind: "tree", path };
}

/**
 * Only a relative reference to an image file inside the same tree is shown.
 * Remote, `data:` and absolute-path images are blocked on purpose: a backup
 * viewer makes no third-party requests, and a document must not be able to
 * make the browser request an arbitrary URL on the app's own origin.
 */
export function classifyImage(filePath: string, src: string | null): ImageTarget {
  if (src === null || src === "") return { kind: "blocked" };
  const path = resolveTreeReference(filePath, src);
  if (path === null || path === "" || browseInlineImageType(path) === null) {
    return { kind: "blocked" };
  }
  return { kind: "tree", path };
}
