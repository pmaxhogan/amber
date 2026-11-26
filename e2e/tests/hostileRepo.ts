import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACKER, README_IDS, buildCorpus } from "./hostilePayloads.ts";
import { PNG_1X1, must } from "./localGitServer.ts";

/**
 * One repository whose every user-visible string is hostile: file and
 * directory names, branch and tag names, commit subjects, bodies and author
 * fields, markdown, an SVG that scripts, and an HTML page named like a PNG.
 */

export const HOSTILE = {
  name: "browse-hostile",
  /** Ref names git accepts (checked by `git check-ref-format` when they are created). */
  branch: `evil"><svg/onload=alert(1);window.__pwn()>`,
  tag: `t"><script>alert(1);window.__pwn()</script>`,
  names: {
    htmlFile: "<img src=x onerror=alert(1);window.__pwn()>.txt",
    quoteFile: `a"b'c&amp;.txt`,
    dashFile: "-rf.txt",
    encodedFile: "%2e%2e",
    htmlDir: "<b>dir",
    symlink: "link-js",
    svg: "evil.svg",
    fakePng: "fake.png",
    realPng: "pixel.png",
  },
  symlinkTarget: "javascript:alert(1)",
} as const;

export interface HostileCommit {
  sha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
}

export interface HostileBuild {
  commits: HostileCommit[];
  familyFiles: string[];
}

const EVIL_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
  `width="40" height="40" onload="alert('svg-onload');window.__pwn&&window.__pwn();top.__pwn()">` +
  `<script>alert('svg-script');window.__pwn&&window.__pwn();top.__pwn()</script>` +
  `<image href="${ATTACKER}/svg-image.png" width="10" height="10"/>` +
  `<style>@import url(${ATTACKER}/svg-css);</style>` +
  `<rect width="30" height="30" fill="#c80"/>` +
  `<a href="javascript:alert('svg-a')"><text y="38">x</text></a></svg>\n`;

/** HTML with a script, saved under a PNG name and without PNG magic bytes. */
const FAKE_PNG = `<html><script>alert('fake-png');window.__pwn&&window.__pwn()</script></html>\n`;

async function commit(
  work: string,
  subject: string,
  body: string,
  author: { name: string; email: string },
): Promise<HostileCommit> {
  await must(["add", "-A"], work);
  await must(
    [
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "--quiet",
      "-m",
      subject,
      "-m",
      body,
    ],
    work,
  );
  const sha = await must(["rev-parse", "HEAD"], work);
  // What git actually stored: it strips angle brackets from identities.
  const authorName = await must(["log", "-1", "--format=%an"], work);
  const authorEmail = await must(["log", "-1", "--format=%ae"], work);
  return { sha, subject, body, authorName, authorEmail };
}

export async function buildHostileRepo(work: string, deadPort: number): Promise<HostileBuild> {
  const { families } = buildCorpus(deadPort);
  const all = Object.values(families).flat();
  const byId = new Map(all.map(([id, text]) => [id, text]));

  const readmeParts = README_IDS.map((id) => {
    const text = byId.get(id);
    if (text === undefined) throw new Error(`unknown payload ${id}`);
    return `## ${id}\n\n${text}`;
  });
  writeFileSync(join(work, "README.md"), `# Hostile Root\n\n${readmeParts.join("\n\n")}\n`);

  mkdirSync(join(work, "payloads", "sub"), { recursive: true });
  const familyFiles: string[] = [];
  for (const [family, payloads] of Object.entries(families)) {
    const file = `${family}.md`;
    familyFiles.push(file);
    writeFileSync(
      join(work, "payloads", file),
      `# Family ${family}\n\n${payloads.map(([id, text]) => `<!-- ${id} -->\n\n${text}`).join("\n\n")}\n`,
    );
  }
  writeFileSync(join(work, "payloads", "sub", "file.md"), "# Sub File\n\nsub body\n");
  writeFileSync(join(work, "payloads", "a.png"), PNG_1X1);
  writeFileSync(join(work, "payloads", "evil.svg"), EVIL_SVG);

  mkdirSync(join(work, "assets"));
  writeFileSync(join(work, "assets", HOSTILE.names.svg), EVIL_SVG);
  writeFileSync(join(work, "assets", HOSTILE.names.fakePng), FAKE_PNG);
  writeFileSync(join(work, "assets", HOSTILE.names.realPng), PNG_1X1);

  const names = join(work, "names");
  mkdirSync(join(names, HOSTILE.names.htmlDir), { recursive: true });
  writeFileSync(join(names, HOSTILE.names.htmlFile), "<script>alert(1)</script>\nline two\n");
  writeFileSync(join(names, HOSTILE.names.quoteFile), `"quoted" 'text' &lt;b&gt;\n`);
  writeFileSync(join(names, HOSTILE.names.dashFile), "dash file\n");
  writeFileSync(join(names, HOSTILE.names.encodedFile), "encoded dots\n");
  writeFileSync(join(names, HOSTILE.names.htmlDir, "README.md"), "# Dir Readme\n\ninside\n");
  symlinkSync(HOSTILE.symlinkTarget, join(names, HOSTILE.names.symlink));

  const commits: HostileCommit[] = [];
  commits.push(
    await commit(work, "initial <b>bold</b> import", "plain first body", {
      name: "Alice",
      email: "alice@example.invalid",
    }),
  );

  writeFileSync(join(names, "second.txt"), "second\n");
  commits.push(
    await commit(
      work,
      `<img src=x onerror=alert(1);window.__pwn()> subject`,
      `<script>alert(1);window.__pwn()</script>\n\n<svg onload=alert(1)>\n"quoted" &lt;i&gt;`,
      { name: `Eve "onmouseover="alert(1)&lt;b&gt;`, email: `eve"onfocus="alert(1)@evil.invalid` },
    ),
  );

  await must(["checkout", "--quiet", "-b", HOSTILE.branch], work);
  writeFileSync(join(work, "branch-only.txt"), "only on the hostile branch\n");
  commits.push(
    await commit(work, "branch work", "", { name: "Bob", email: "bob@example.invalid" }),
  );
  await must(["checkout", "--quiet", "main"], work);

  await must(["tag", "-a", HOSTILE.tag, "-m", "<img src=x onerror=alert(1)>"], work);
  return { commits, familyFiles };
}
