/**
 * Colors for the markdown frame's stylesheet, read from the app's theme.
 *
 * The frame is its own document, so the app's CSS variables do not reach it.
 * The parent reads the computed colors and the frame stylesheet gets them as
 * literals. Only values that pass `isColorLiteral` are used; anything else
 * falls back to a fixed default, so nothing but a color can land in a rule.
 */

export interface FrameTheme {
  dark: boolean;
  text: string;
  muted: string;
  background: string;
  border: string;
  link: string;
  codeBackground: string;
}

export const DARK_FRAME_THEME: FrameTheme = {
  dark: true,
  text: "#f5efe7",
  muted: "#b5aca1",
  background: "#1c1713",
  border: "#3d342c",
  link: "#f2b33d",
  codeBackground: "#2a231d",
};

export const LIGHT_FRAME_THEME: FrameTheme = {
  dark: false,
  text: "#1f1a16",
  muted: "#665c52",
  background: "#ffffff",
  border: "#ddd5cc",
  link: "#9a5b00",
  codeBackground: "#f3efea",
};

/**
 * A hex color, or a color function whose arguments are only numbers, letters,
 * `%`, `.`, `,`, `/`, `+`, `-` and spaces. No quotes, parentheses, semicolons,
 * braces or backslashes, so a value can never close the declaration it sits in.
 */
const COLOR_LITERAL =
  /^(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([0-9a-zA-Z.,%/ +-]{1,80}\))$/;

export function isColorLiteral(value: string): boolean {
  return value.length <= 100 && COLOR_LITERAL.test(value);
}

function transparent(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  return compact === "" || compact === "transparent" || /^rgba\(\d+,\d+,\d+,0\)$/.test(compact);
}

/** The computed color a CSS variable resolves to at `host`, or null when it is not set. */
function probeColor(host: Element, variable: string): string | null {
  const doc = host.ownerDocument;
  const view = doc.defaultView;
  if (view === null) return null;
  // An undefined variable would make `color: var(--x)` inherit the host's
  // text color, which is a valid color and would slip past the fallback.
  if (view.getComputedStyle(host).getPropertyValue(variable).trim() === "") return null;
  const probe = doc.createElement("span");
  probe.style.display = "none";
  probe.style.color = `var(${variable})`;
  host.appendChild(probe);
  try {
    const value = view.getComputedStyle(probe).color.trim();
    return value === "" ? null : value;
  } finally {
    probe.remove();
  }
}

/** The first non-transparent background at or above `host`. */
function effectiveBackground(host: Element): string | null {
  const view = host.ownerDocument.defaultView;
  if (view === null) return null;
  for (let node: Element | null = host; node !== null; node = node.parentElement) {
    const value = view.getComputedStyle(node).backgroundColor.trim();
    if (!transparent(value)) return value;
  }
  return null;
}

function pick(candidate: string | null, fallback: string): string {
  return candidate !== null && isColorLiteral(candidate) ? candidate : fallback;
}

/** Reads the frame colors from the app theme around `host`. */
export function readFrameTheme(host: Element, dark: boolean): FrameTheme {
  const base = dark ? DARK_FRAME_THEME : LIGHT_FRAME_THEME;
  return {
    dark,
    text: pick(probeColor(host, "--p-text-color"), base.text),
    muted: pick(probeColor(host, "--p-text-muted-color"), base.muted),
    background: pick(effectiveBackground(host), base.background),
    border: pick(probeColor(host, "--p-content-border-color"), base.border),
    link: pick(probeColor(host, "--p-primary-color"), base.link),
    codeBackground: pick(probeColor(host, "--p-content-hover-background"), base.codeBackground),
  };
}

/** A theme with every color checked again, for the document builder. */
export function validatedTheme(theme: FrameTheme): FrameTheme {
  const base = theme.dark ? DARK_FRAME_THEME : LIGHT_FRAME_THEME;
  return {
    dark: theme.dark === true,
    text: pick(theme.text, base.text),
    muted: pick(theme.muted, base.muted),
    background: pick(theme.background, base.background),
    border: pick(theme.border, base.border),
    link: pick(theme.link, base.link),
    codeBackground: pick(theme.codeBackground, base.codeBackground),
  };
}
