import { describe, expect, it } from "vitest";
import {
  assertSafeFrameDocument,
  buildFrameDocument,
  frameContentSecurityPolicy,
  frameImageSource,
  frameStylesheet,
} from "../src/lib/markdown/frameDocument.ts";
import { DEFAULT_MARKDOWN_BUDGET } from "../src/lib/markdown/budget.ts";
import { MarkdownBudgetError, MarkdownRenderError } from "../src/lib/markdown/render.ts";
import {
  DARK_FRAME_THEME,
  LIGHT_FRAME_THEME,
  isColorLiteral,
  readFrameTheme,
} from "../src/lib/markdown/theme.ts";

const ORIGIN = "https://amber.test";
const COMMIT = "b".repeat(40);
const IMG = `${ORIGIN}/api/repos/3/browse/raw?rev=${COMMIT}&path=a.png&inline=1`;

function build(bodyHtml: string, theme = DARK_FRAME_THEME): string {
  return buildFrameDocument({ bodyHtml, origin: ORIGIN, repoId: 3, theme });
}

describe("frame CSP", () => {
  it("allows images only from this repository's raw endpoint", () => {
    expect(frameImageSource(ORIGIN, 3)).toBe("https://amber.test/api/repos/3/browse/raw");
    expect(frameContentSecurityPolicy(ORIGIN, 3)).toBe(
      "default-src 'none'; img-src https://amber.test/api/repos/3/browse/raw; " +
        "style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'",
    );
  });

  it.each(["https://a.test/", "https://a.test;x", "javascript:x", "https://a b", "ftp://a.test"])(
    "refuses origin %j",
    (origin) => {
      expect(() => frameImageSource(origin, 3)).toThrow(MarkdownRenderError);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, 2 ** 60])("refuses repo id %s", (repoId) => {
    expect(() => frameImageSource(ORIGIN, repoId)).toThrow(MarkdownRenderError);
  });

  it("accepts a localhost origin with a port", () => {
    expect(frameImageSource("http://localhost:5173", 1)).toBe(
      "http://localhost:5173/api/repos/1/browse/raw",
    );
  });
});

describe("buildFrameDocument", () => {
  it("puts the CSP meta first in the head, then referrer, base and style", () => {
    const html = build("<p>hi</p>");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const head = Array.from(doc.head.children).map((el) => el.outerHTML.slice(0, 40));
    expect(doc.head.children[0]?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(doc.head.children[1]?.getAttribute("name")).toBe("referrer");
    expect(doc.head.children[2]?.localName).toBe("base");
    expect(doc.head.children[2]?.getAttribute("target")).toBe("_blank");
    expect(doc.head.children[2]?.hasAttribute("href")).toBe(false);
    expect(doc.head.children[3]?.localName).toBe("style");
    expect(head).toHaveLength(4);
    expect(html).not.toMatch(/<script/i);
  });

  it("never puts repository data inside the stylesheet", () => {
    const body = "<p>}</style><style>body{background:url(https://evil.test/x)}</p>";
    const html = build(body.replace(/</g, "&lt;"));
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.head.querySelector("style")?.textContent).toBe(frameStylesheet(DARK_FRAME_THEME));
    expect(doc.head.querySelector("style")?.textContent).not.toContain("evil");
  });

  it("accepts every URL shape the rewrite pass emits", () => {
    expect(() =>
      build(
        '<a href="#" data-amber-path="docs/a.md" target="_blank" rel="noopener noreferrer nofollow">a</a>' +
          '<a href="https://example.com/" target="_blank" rel="noopener noreferrer nofollow">b</a>' +
          `<img src="${IMG.replace(/&/g, "&amp;")}" alt="x" width="10" height="50%">` +
          '<span data-amber-blocked="">[image]</span><a target="_blank" rel="noopener noreferrer nofollow">plain</a>w<wbr>w' +
          '<table><tbody><tr><td colspan="2" align="center">c</td></tr></tbody></table>',
      ),
    ).not.toThrow();
  });

  it.each([
    ["script", "<script>alert(1)</script>"],
    ["event handler", '<p onclick="x">a</p>'],
    ["style attribute", '<p style="color:red">a</p>'],
    ["style element", "<style>p{}</style>"],
    ["svg", "<svg></svg>"],
    ["iframe", "<iframe></iframe>"],
    ["meta", '<meta http-equiv="refresh" content="0;url=https://evil.test">'],
    ["base", '<base href="https://evil.test/">'],
    ["form", "<form></form>"],
    ["comment", "<!-- x -->"],
    ["javascript link", '<a href="javascript:alert(1)">a</a>'],
    ["relative link", '<a href="docs/a.md">a</a>'],
    ["tree link with a real href", '<a href="docs/a.md" data-amber-path="docs/a.md">a</a>'],
    ["bad tree path", '<a href="#" data-amber-path="../etc">a</a>'],
    ["link target without rel", '<a href="https://e.test/" target="_blank">a</a>'],
    ["tree link without a target", '<a href="#" data-amber-path="a">a</a>'],
    ["link without a target", "<a>plain</a>"],
    [
      "link with another target",
      '<a href="https://e.test/" target="_self" rel="noopener noreferrer nofollow">a</a>',
    ],
    [
      "link to the app origin",
      '<a href="https://amber.test/api/repos/1" target="_blank" rel="noopener noreferrer nofollow">a</a>',
    ],
    ["huge width", '<img width="2001">'],
    ["huge percentage", '<img height="101%">'],
    ["wbr with an attribute", '<wbr title="x">'],
    ["a stand-in element", "<amber-b>x</amber-b>"],
    ["remote image", '<img src="https://evil.test/x.png">'],
    ["other api image", `<img src="${ORIGIN}/api/repos/4/browse/raw?rev=x">`],
    ["relative image", '<img src="a.png">'],
    ["data attribute", '<p data-x="1">a</p>'],
    ["class", '<p class="x">a</p>'],
    ["id", '<p id="x">a</p>'],
    ["odd width", '<img width="1;x">'],
  ])("refuses a body with %s", (_name, body) => {
    expect(() => build(body)).toThrow(MarkdownRenderError);
  });

  it("refuses a body over the size budget before parsing it", () => {
    expect(() =>
      buildFrameDocument({
        bodyHtml: "x".repeat(101),
        origin: ORIGIN,
        repoId: 3,
        theme: DARK_FRAME_THEME,
        budget: { ...DEFAULT_MARKDOWN_BUDGET, maxBodyChars: 100 },
      }),
    ).toThrow(MarkdownBudgetError);
    expect(DEFAULT_MARKDOWN_BUDGET.maxBodyChars).toBe(2 * 1024 * 1024);
  });

  it("refuses a body whose parse builds far more elements than were serialized", () => {
    const body = "<p>x</p>".repeat(40);
    const opts = { bodyHtml: body, origin: ORIGIN, repoId: 3, theme: DARK_FRAME_THEME };
    expect(() => buildFrameDocument({ ...opts, expectedElements: 40 })).not.toThrow();
    expect(() => buildFrameDocument({ ...opts, expectedElements: 10 })).toThrow(
      MarkdownBudgetError,
    );
  });

  it("refuses table spans outside the clamps", () => {
    expect(() => build('<table><tbody><tr><td colspan="21">x</td></tr></tbody></table>')).toThrow();
    expect(() => build('<table><tbody><tr><td rowspan="51">x</td></tr></tbody></table>')).toThrow();
    expect(() => build('<table><tbody><tr><td rowspan="0">x</td></tr></tbody></table>')).toThrow();
    expect(() =>
      build('<table><tbody><tr><td colspan="20" rowspan="50">x</td></tr></tbody></table>'),
    ).not.toThrow();
  });

  it("refuses a body that tries to close the document and add head content", () => {
    expect(() => build("</body></html><html><head><meta http-equiv=refresh content=0>")).toThrow(
      MarkdownRenderError,
    );
  });

  it("refuses a head that is not exactly ours", () => {
    const csp = frameContentSecurityPolicy(ORIGIN, 3);
    const css = frameStylesheet(DARK_FRAME_THEME);
    const expect_ = { csp, css, imageSource: frameImageSource(ORIGIN, 3), appOrigin: ORIGIN };
    const ok =
      `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `<meta name="referrer" content="no-referrer"><base target="_blank"><style>${css}</style>` +
      "</head><body><p>x</p></body></html>";
    expect(() => assertSafeFrameDocument(ok, expect_)).not.toThrow();
    expect(() =>
      assertSafeFrameDocument(ok.replace("default-src 'none'", "default-src *"), expect_),
    ).toThrow(MarkdownRenderError);
    expect(() =>
      assertSafeFrameDocument(ok.replace('<base target="_blank">', ""), expect_),
    ).toThrow(MarkdownRenderError);
    expect(() =>
      assertSafeFrameDocument(ok.replace("<body>", '<body onload="x">'), expect_),
    ).toThrow(MarkdownRenderError);
  });
});

describe("frame theme", () => {
  it.each(["#fff", "#1c1713", "rgb(28, 23, 19)", "rgba(0, 0, 0, 0.5)", "oklch(0.7 0.1 50)"])(
    "accepts color literal %j",
    (value) => {
      expect(isColorLiteral(value)).toBe(true);
    },
  );

  it.each([
    "red;background:url(x)",
    "rgb(1,2,3)}body{x:y",
    "url(https://evil.test)",
    "var(--x)",
    "rgb(1,2,3) /* x */",
    'rgb("1")',
    "expression(alert(1))",
    "",
  ])("refuses %j", (value) => {
    expect(isColorLiteral(value)).toBe(false);
  });

  it("falls back to the defaults for anything that is not a color literal", () => {
    const css = frameStylesheet({ ...LIGHT_FRAME_THEME, text: "red;}body{background:url(x)" });
    expect(css).toContain(`color:${LIGHT_FRAME_THEME.text};`);
    expect(css).not.toContain("url(x)");
    expect(css).toContain("color-scheme:light");
    // Clamped frames scroll inside instead of growing without bound.
    expect(css).toContain("overflow-y:auto");
  });

  it("reads computed colors from the host, falling back per value", () => {
    const host = document.createElement("div");
    host.style.backgroundColor = "rgb(1, 2, 3)";
    document.body.appendChild(host);
    const theme = readFrameTheme(host, false);
    host.remove();
    expect(theme.dark).toBe(false);
    expect(theme.background).toBe("rgb(1, 2, 3)");
    // No --p-* variables are defined here, so nothing may fall back to the
    // inherited text color: every value is the default.
    expect(theme.text).toBe(LIGHT_FRAME_THEME.text);
    expect(theme.codeBackground).toBe(LIGHT_FRAME_THEME.codeBackground);
    for (const value of [theme.text, theme.muted, theme.border, theme.link, theme.codeBackground]) {
      expect(isColorLiteral(value)).toBe(true);
    }
  });
});
