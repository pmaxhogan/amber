import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKDOWN_BUDGET,
  assertHtmlWithinBudget,
  countHtml,
} from "../src/lib/markdown/budget.ts";
import {
  LONG_RUN,
  LONG_RUN_STEP,
  MAX_COLSPAN,
  MAX_ROWSPAN,
  MAX_TREE_IMAGES,
  isSafeBreak,
  MarkdownBudgetError,
  MarkdownRenderError,
  displayText,
  isSaneDimension,
  markdownToHtml,
  renderMarkdown,
  renderMarkdownBody,
  standInFormattingTags,
  type RenderOptions,
  type Sanitizer,
} from "../src/lib/markdown/render.ts";

/*
 * These run on happy-dom, whose HTML parser is not a browser's. Nothing here
 * is evidence about XSS: the real hostile corpus runs in Chromium with
 * Playwright. What these do cover is the logic around the sanitizer: the
 * rewrite pass, the fail-closed paths and the URL shapes we emit.
 *
 * Under happy-dom, DOMPurify reports `isSupported` as true but builds its
 * fragment in the live document and does not actually clean it (an `onerror`
 * survives). The render refuses a fragment that lives in the live document,
 * so the real sanitizer fails closed here; the rewrite-pass tests therefore
 * use a pass-through fake that parses into a separate document.
 */

const ORIGIN = "https://amber.test";
const IMAGE_SOURCE = `${ORIGIN}/api/repos/7/browse/raw`;
const COMMIT = "a".repeat(40);

function imageUrl(path: string): string {
  return `${IMAGE_SOURCE}?rev=${COMMIT}&path=${encodeURIComponent(path)}&inline=1`;
}

/** Parses without cleaning anything, into a document that is not the live one. */
function passThrough(): Sanitizer {
  return {
    isSupported: true,
    sanitize(html: string): DocumentFragment {
      const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
      const fragment = doc.createDocumentFragment();
      while (doc.body.firstChild !== null) fragment.appendChild(doc.body.firstChild);
      // happy-dom gives every fragment the live document as its owner, which
      // the render rightly refuses. In a browser DOMPurify's fragment belongs
      // to its own inert document; this restores that shape for the test.
      Object.defineProperty(fragment, "ownerDocument", { value: doc });
      return fragment;
    },
  };
}

function options(overrides: Partial<RenderOptions> = {}): RenderOptions {
  return {
    filePath: "docs/README.md",
    imageUrl,
    imageSource: IMAGE_SOURCE,
    sanitizer: passThrough(),
    ...overrides,
  };
}

function parse(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return doc.body;
}

describe("markdownToHtml", () => {
  it("renders GFM tables with align attributes instead of style", () => {
    const html = markdownToHtml("| a | b |\n|:-:|--:|\n| 1 | 2 |\n");
    expect(html).toContain('<th align="center">a</th>');
    expect(html).toContain('<td align="right">2</td>');
    expect(html).not.toContain("style=");
  });

  it("renders strikethrough and keeps typographer off", () => {
    expect(markdownToHtml('~~gone~~ "quotes" -- dash')).toContain("<s>gone</s>");
    expect(markdownToHtml('"quotes" -- dash')).toContain("&quot;quotes&quot; -- dash");
  });

  it("does not let markdown-it emit javascript: links", () => {
    expect(markdownToHtml("[x](javascript:alert(1))")).not.toMatch(/href="javascript/i);
  });
});

describe("renderMarkdownBody rewrite pass", () => {
  it("turns a tree link into href=# plus our path attribute", () => {
    const body = parse(renderMarkdownBody("[guide](guide/intro.md#start)", options()));
    const link = body.querySelector("a");
    expect(link?.getAttribute("href")).toBe("#");
    expect(link?.getAttribute("data-amber-path")).toBe("docs/guide/intro.md");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("keeps an external link, re-serialized, with target and rel", () => {
    const body = parse(renderMarkdownBody("[site](HTTPS://Example.com/a)", options()));
    const link = body.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });

  it("drops the href of anything else", () => {
    const html = renderMarkdownBody(
      '<a href="/api/repos/1">abs</a> <a href="#x">frag</a> <a href="../../../x">out</a>',
      options(),
    );
    for (const link of Array.from(parse(html).querySelectorAll("a"))) {
      expect(link.hasAttribute("href")).toBe(false);
    }
  });

  it("refuses a data-amber-path the document wrote itself", () => {
    // Only reachable if the sanitizer let a data attribute through.
    expect(() =>
      renderMarkdownBody('<a href="https://x.test" data-amber-path="a">x</a>', options()),
    ).toThrow(MarkdownRenderError);
  });

  it("points tree images at the raw endpoint", () => {
    const body = parse(renderMarkdownBody("![shot](./img/shot.png)", options()));
    expect(body.querySelector("img")?.getAttribute("src")).toBe(imageUrl("docs/img/shot.png"));
  });

  it("replaces remote, data and absolute images with a text placeholder", () => {
    const html = renderMarkdownBody(
      [
        "![badge](https://img.shields.io/x.svg)",
        "![dot](data:image/png;base64,AAAA)",
        '<img src="/api/repos/7/browse/raw?rev=x&path=y.png" alt="abs">',
        '<img alt="none">',
      ].join("\n\n"),
      options(),
    );
    const body = parse(html);
    expect(body.querySelectorAll("img")).toHaveLength(0);
    const placeholders = Array.from(body.querySelectorAll("span[data-amber-blocked]"));
    expect(placeholders.map((span) => span.textContent)).toEqual([
      "[image: badge]",
      "[image: dot]",
      "[image: abs]",
      "[image: none]",
    ]);
  });

  it("drops presentational attributes with odd values", () => {
    const body = parse(
      renderMarkdownBody(
        '<p align="evil">x</p><img src="a.png" width="10;x" height="50%">',
        options(),
      ),
    );
    expect(body.querySelector("p")?.hasAttribute("align")).toBe(false);
    expect(body.querySelector("img")?.hasAttribute("width")).toBe(false);
    expect(body.querySelector("img")?.getAttribute("height")).toBe("50%");
  });

  it("removes comments", () => {
    expect(renderMarkdownBody("a\n\n<!-- hidden -->\n\nb", options())).not.toContain("<!--");
  });

  it("refuses an element or attribute the sanitizer should have removed", () => {
    expect(() => renderMarkdownBody("<script>x</script>", options())).toThrow(MarkdownRenderError);
    expect(() => renderMarkdownBody('<p onclick="x">a</p>', options())).toThrow(
      MarkdownRenderError,
    );
    expect(() => renderMarkdownBody('<p style="color:red">a</p>', options())).toThrow(
      MarkdownRenderError,
    );
  });

  it("refuses an image URL builder that leaves the raw endpoint", () => {
    expect(() =>
      renderMarkdownBody(
        "![x](a.png)",
        options({ imageUrl: () => "https://amber.test/api/repos/7/browse/raw/../../x?y" }),
      ),
    ).toThrow(MarkdownRenderError);
    expect(() =>
      renderMarkdownBody("![x](a.png)", options({ imageUrl: () => "https://evil.test/x.png" })),
    ).toThrow(MarkdownRenderError);
  });
});

describe("renderMarkdownBody fail-closed paths", () => {
  it("throws when the sanitizer is not supported", () => {
    const sanitizer: Sanitizer = { ...passThrough(), isSupported: false };
    expect(() => renderMarkdownBody("hello", options({ sanitizer }))).toThrow(MarkdownRenderError);
  });

  it("throws when the sanitizer throws or returns something odd", () => {
    const throwing: Sanitizer = {
      isSupported: true,
      sanitize() {
        throw new Error("boom");
      },
    };
    expect(() => renderMarkdownBody("hello", options({ sanitizer: throwing }))).toThrow("boom");
    const stringy = {
      isSupported: true,
      sanitize: () => "<p>hello</p>" as unknown as DocumentFragment,
    };
    expect(() => renderMarkdownBody("hello", options({ sanitizer: stringy }))).toThrow(
      MarkdownRenderError,
    );
  });

  it("throws when the fragment lives in the live document", () => {
    const live: Sanitizer = {
      isSupported: true,
      sanitize: () => document.createDocumentFragment(),
    };
    expect(() => renderMarkdownBody("hello", options({ sanitizer: live }))).toThrow(
      MarkdownRenderError,
    );
  });

  it("with the real DOMPurify, either fails closed or emits nothing executable (smoke only)", () => {
    const hostile =
      '<img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><svg onload=alert(1)></svg>' +
      "<script>alert(1)</script>";
    let html: string;
    try {
      html = renderMarkdownBody(hostile, options({ sanitizer: undefined }));
    } catch (cause) {
      expect(cause).toBeInstanceOf(MarkdownRenderError);
      return;
    }
    expect(html).not.toMatch(/onerror|onload|javascript:|<script|<svg/i);
  });
});

describe("formatting stand-ins", () => {
  it("renames every formatting tag the tokenizer would see, in any case", () => {
    expect(standInFormattingTags('<b>x</B> <A\thref="y">z</a> <strong/> <CODE\n>c</code> <i')).toBe(
      '<amber-b>x</amber-b> <amber-a\thref="y">z</amber-a> <amber-strong/> <amber-code\n>c</amber-code> <amber-i',
    );
  });

  it("leaves other tags alone, including ones that merely start with a formatting name", () => {
    const html = "<br><bdi>x</bdi><abbr>y</abbr><b-x>z</b-x><span>s</span><strike-not>";
    expect(standInFormattingTags(html)).toBe(html);
  });

  it("restores the real elements after sanitizing", () => {
    const html = renderMarkdownBody(
      "**bold** *em* `code` ~~gone~~ [l](https://e.test/)",
      options(),
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<s>gone</s>");
    expect(html).not.toContain("amber-");
  });

  it("unwraps a link nested in another link", () => {
    const body = parse(
      renderMarkdownBody(
        '<a href="https://a.test/">x <a href="https://b.test/">y</a></a>',
        options(),
      ),
    );
    expect(body.querySelectorAll("a a")).toHaveLength(0);
  });
});

describe("links leaving the rewrite pass", () => {
  it("every link carries target=_blank and our rel, whatever it points at", () => {
    const body = parse(
      renderMarkdownBody(
        [
          "[tree](a.md) [ext](https://e.test/) [dead](nowhere:x) [frag](#x)",
          '<a>no href</a> <a href="javascript:alert(1)">js</a> <a href="https://amber.test/x">self</a>',
        ].join("\n\n"),
        options(),
      ),
    );
    const links = Array.from(body.querySelectorAll("a"));
    expect(links.length).toBe(7);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    }
  });

  it("drops an absolute link to the app's own origin", () => {
    const body = parse(
      renderMarkdownBody("[export](https://amber.test/api/repos/9/export/tree.zip)", options()),
    );
    expect(body.querySelector("a")?.hasAttribute("href")).toBe(false);
  });

  it("strips bidi controls and invisible characters from link text", () => {
    const { links } = renderMarkdown("[Link ‮gnp.exe](https://e.test/) [a​b⁦c⁩](b.md)", options());
    expect(links.map((link) => link.text)).toEqual(["Link gnp.exe", "abc"]);
    expect(displayText(" a\u0000b‭c d﻿ ")).toBe("abc d");
  });
});

describe("images and sizes", () => {
  it(`shows at most ${MAX_TREE_IMAGES} tree images, the rest as placeholders`, () => {
    const source = Array.from({ length: 250 }, (_, i) => `![i${i}](i${i}.png)`).join(" ");
    const body = parse(renderMarkdownBody(source, options()));
    expect(body.querySelectorAll("img")).toHaveLength(MAX_TREE_IMAGES);
    expect(body.querySelectorAll("span[data-amber-blocked]")).toHaveLength(50);
  });

  it("drops width and height beyond the bounds", () => {
    expect(isSaneDimension("2000")).toBe(true);
    expect(isSaneDimension("2001")).toBe(false);
    expect(isSaneDimension("100%")).toBe(true);
    expect(isSaneDimension("101%")).toBe(false);
    const body = parse(
      renderMarkdownBody(
        '<img src="a.png" width="1" height="99999">\n\n<p width="50%">x</p>',
        options(),
      ),
    );
    expect(body.querySelector("img")?.getAttribute("width")).toBe("1");
    expect(body.querySelector("img")?.hasAttribute("height")).toBe(false);
    expect(body.querySelector("p")?.getAttribute("width")).toBe("50%");
  });

  it("adds break opportunities to very long runs outside pre", () => {
    const run = "www.".repeat(100);
    const html = renderMarkdownBody(`${run}\n\n    ${run}\n\n${"x".repeat(LONG_RUN)} y`, options());
    const body = parse(html);
    const paragraphs = body.querySelectorAll("p");
    // Breaks fall at 240 and 320 characters; none at the very end of the text.
    expect(LONG_RUN).toBe(200);
    expect(LONG_RUN_STEP).toBe(80);
    expect(paragraphs[0]?.querySelectorAll("wbr").length).toBe(2);
    expect(paragraphs[0]?.textContent).toBe(run);
    expect(body.querySelector("pre")?.querySelectorAll("wbr")).toHaveLength(0);
    expect(paragraphs[1]?.querySelectorAll("wbr")).toHaveLength(0);
  });
});

describe("work budget", () => {
  function spySanitizer(): Sanitizer & { calls: number } {
    const inner = passThrough();
    const spy = {
      calls: 0,
      isSupported: true,
      sanitize(html: string, cfg: Parameters<Sanitizer["sanitize"]>[1]) {
        spy.calls += 1;
        return inner.sanitize(html, cfg);
      },
    };
    return spy;
  }

  it("refuses an oversized source before markdown-it or the sanitizer runs", () => {
    const sanitizer = spySanitizer();
    expect(() =>
      renderMarkdown(
        "x".repeat(DEFAULT_MARKDOWN_BUDGET.maxSourceChars + 1),
        options({ sanitizer }),
      ),
    ).toThrow(MarkdownBudgetError);
    expect(sanitizer.calls).toBe(0);
  });

  it("refuses too many start tags before the sanitizer parses anything", () => {
    const sanitizer = spySanitizer();
    expect(() =>
      renderMarkdown(
        "<br>".repeat(DEFAULT_MARKDOWN_BUDGET.maxStartTags + 1),
        options({ sanitizer }),
      ),
    ).toThrow(MarkdownBudgetError);
    expect(sanitizer.calls).toBe(0);
    expect(() =>
      renderMarkdown(
        "<br>".repeat(DEFAULT_MARKDOWN_BUDGET.maxStartTags - 1),
        options({ sanitizer }),
      ),
    ).not.toThrow();
  });

  it("refuses too many details elements", () => {
    const source = "<details><summary>s</summary>x</details>".repeat(
      DEFAULT_MARKDOWN_BUDGET.maxDetailsTags + 1,
    );
    expect(() => renderMarkdown(source, options())).toThrow(MarkdownBudgetError);
  });

  it("counts pessimistically: tags in attribute values count, closing tags earn nothing", () => {
    expect(countHtml('<p title="<b>x</b><i>">y</p>')).toEqual({
      startTags: 3,
      tagTokens: 5,
      formattingTags: 2,
      detailsTags: 0,
    });
    expect(countHtml("a < b <1 <-x </ ").startTags).toBe(0);
    expect(countHtml("<DETAILS open><details\n>").detailsTags).toBe(2);
  });

  it("treats a formatting tag reaching the parser as a render failure", () => {
    expect(() => assertHtmlWithinBudget("<b>x", DEFAULT_MARKDOWN_BUDGET)).toThrow(
      MarkdownRenderError,
    );
    expect(() => assertHtmlWithinBudget("<amber-b>x", DEFAULT_MARKDOWN_BUDGET)).not.toThrow();
  });

  it("is a MarkdownRenderError too, so every caller fails closed", () => {
    expect(new MarkdownBudgetError("x")).toBeInstanceOf(MarkdownRenderError);
  });
});

describe("round 2: structure, tables, breaks", () => {
  it("restores a formatting element only around phrasing content", () => {
    const html = renderMarkdownBody(
      '<div><b title="t1"><div>x</div></b><b title="t2">y <i>z</i></b><a href="https://e.test/"><p>q</p></a></div>',
      options(),
    );
    const body = parse(html);
    expect(body.querySelectorAll("b")).toHaveLength(1);
    expect(body.querySelector("b")?.getAttribute("title")).toBe("t2");
    expect(body.querySelector("i")).not.toBeNull();
    const spans = Array.from(body.querySelectorAll("span"));
    expect(spans.map((span) => span.getAttribute("title"))).toEqual(["t1", null]);
    // A link around a block becomes a plain span and loses its href.
    expect(body.querySelectorAll("a")).toHaveLength(0);
    for (const element of Array.from(body.querySelectorAll("b, i, a, strong, em, code, s"))) {
      expect(element.querySelector("p, div, li, table, pre, h1, details, blockquote")).toBeNull();
    }
  });

  it("reports the element count of the body it serialized", () => {
    const result = renderMarkdown("# a\n\n**b** [c](d.md)", options());
    expect(result.elementCount).toBe(parse(result.bodyHtml).querySelectorAll("*").length);
  });

  it("clamps table spans and drops zero spans", () => {
    const body = parse(
      renderMarkdownBody(
        '<table><tr><td colspan="1000" rowspan="65534">a</td><td colspan="0" rowspan="0">b</td></tr></table>',
        options(),
      ),
    );
    const [first, second] = Array.from(body.querySelectorAll("td"));
    expect(first?.getAttribute("colspan")).toBe(String(MAX_COLSPAN));
    expect(first?.getAttribute("rowspan")).toBe(String(MAX_ROWSPAN));
    expect(second?.hasAttribute("colspan")).toBe(false);
    expect(second?.hasAttribute("rowspan")).toBe(false);
  });

  it("fails closed on too many cells, too wide a row, or too large a grid", () => {
    const budget = (overrides: object) => ({ ...DEFAULT_MARKDOWN_BUDGET, ...overrides });
    const row = (cells: string) => `<table><tr>${cells}</tr></table>`;
    expect(() =>
      renderMarkdown(
        row("<td>x</td>".repeat(11)),
        options({ budget: budget({ maxTableCells: 10 }) }),
      ),
    ).toThrow(MarkdownBudgetError);
    expect(() =>
      renderMarkdown(
        row('<td colspan="20">x</td>'.repeat(3)),
        options({ budget: budget({ maxRowColumns: 59 }) }),
      ),
    ).toThrow("too wide");
    // Rowspans carry forward: 10 rows each starting a 20x50 block grow the
    // widest row to 200 columns, an area of 2000.
    const tall =
      "<table>" + '<tr><td rowspan="50" colspan="20">x</td></tr>'.repeat(10) + "</table>";
    expect(() => renderMarkdown(tall, options({ budget: budget({ maxTableArea: 1999 }) }))).toThrow(
      "too large",
    );
    expect(() =>
      renderMarkdown(tall, options({ budget: budget({ maxTableArea: 2000 }) })),
    ).not.toThrow();
  });

  it("never breaks inside a surrogate pair, before a mark or after a joiner", () => {
    expect(isSafeBreak("a\u{1F600}", 2)).toBe("no");
    expect(isSafeBreak("a\u0301", 1)).toBe("avoid");
    expect(isSafeBreak("a\u200db", 2)).toBe("avoid");
    expect(isSafeBreak("a\ufe0f", 1)).toBe("avoid");
    expect(isSafeBreak("\u{1F44D}\u{1F3FD}", 2)).toBe("avoid");
    expect(isSafeBreak("ab", 1)).toBe("yes");
    const emoji = "x" + "\u{1F600}".repeat(400);
    const body = parse(renderMarkdownBody(emoji, options()));
    expect(body.querySelector("p")?.textContent).toBe(emoji);
    expect(body.querySelectorAll("wbr").length).toBeGreaterThan(0);
    for (const text of Array.from(body.querySelector("p")?.childNodes ?? [])) {
      if (text.nodeType !== 3) continue;
      const data = (text as Text).data;
      expect(/^[\udc00-\udfff]/.test(data)).toBe(false);
      expect(/[\ud800-\udbff]$/.test(data)).toBe(false);
    }
  });

  it("still breaks a long run of combining marks eventually", () => {
    const marks = "a" + "\u0301".repeat(1000);
    const body = parse(renderMarkdownBody(marks, options()));
    expect(body.querySelector("p")?.textContent).toBe(marks);
    expect(body.querySelectorAll("wbr").length).toBeGreaterThan(0);
  });
});
