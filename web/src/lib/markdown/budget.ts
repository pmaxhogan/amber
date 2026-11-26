/**
 * Work limits for rendering one markdown file.
 *
 * The expensive step is not ours: it is the browser's HTML parser, inside
 * DOMPurify, building a DOM from the markdown-it output, and the parse of the
 * frame document after it. Hostile markup can make those parses super-linear
 * and nothing can interrupt them on the main thread. Two families matter:
 *
 * - Unclosed formatting elements (`<b>`, `<a>`, ...). The parser re-creates
 *   them after every pop, so a few hundred of them nested in `<div>`s that
 *   close later cost seconds to minutes. render.ts takes these away entirely:
 *   formatting tags are renamed to ordinary stand-in elements before the
 *   parse, so the string checked here must contain none (checked below).
 * - Deep nesting of ordinary elements (`<div>`, `<ul><li>`, tables,
 *   `<details>`), whose cost grows with the number of start tags.
 *
 * So the HTML string is measured before anything parses it, and a file over a
 * limit is shown as plain text. Counting is pessimistic, because a tag that
 * hides from the count is a tag that can stall the tab: any `<` followed by
 * an ASCII letter counts as a start tag (the tokenizer cannot begin one any
 * other way), text that only looks like a tag is over-counted, and closing
 * tags never earn credit.
 *
 * The limits come from timing the worst families in Chromium and WebKit and
 * keeping every input that passes under about a second of main-thread work,
 * while the largest real READMEs measured still render.
 */

import { MarkdownBudgetError, MarkdownRenderError } from "./errors.ts";

export interface MarkdownBudget {
  /** Longest source rendered at all, in UTF-16 code units. */
  maxSourceChars: number;
  /** Most start tags in the markdown-it output. */
  maxStartTags: number;
  /**
   * Most `<details>` start tags. Nested details are the costliest element per
   * tag measured (mostly layout in the frame), so they get a tighter cap.
   */
  maxDetailsTags: number;
  /** Most table cells (`td` and `th`) in the document. */
  maxTableCells: number;
  /** Most columns in one table row, counting colspans and rowspans from above. */
  maxRowColumns: number;
  /** Most grid slots over all tables: each table's rows times its widest row. */
  maxTableArea: number;
  /** Longest sanitized body handed to the second parse in buildFrameDocument. */
  maxBodyChars: number;
}

export const DEFAULT_MARKDOWN_BUDGET: Readonly<MarkdownBudget> = {
  maxSourceChars: 256 * 1024,
  maxStartTags: 10_000,
  maxDetailsTags: 1_000,
  maxTableCells: 10_000,
  maxRowColumns: 10_000,
  maxTableArea: 1_000_000,
  maxBodyChars: 2 * 1024 * 1024,
};

/** A formatting-element start tag as the tokenizer reads one; see render.ts. */
const FORMATTING_START =
  /<(?:a|b|big|code|em|font|i|nobr|s|small|strike|strong|tt|u)(?=[\t\n\f\r />]|$)/gi;
const START_TAG = /<[A-Za-z]/g;
const DETAILS_START = /<details(?=[\t\n\f\r />]|$)/gi;
const TAG_TOKEN = /<\/?[A-Za-z]/g;

export interface HtmlCounts {
  startTags: number;
  tagTokens: number;
  formattingTags: number;
  detailsTags: number;
}

function count(pattern: RegExp, text: string): number {
  pattern.lastIndex = 0;
  let total = 0;
  while (pattern.exec(text) !== null) total += 1;
  return total;
}

/** Pessimistic counts over an HTML string; see the module comment. */
export function countHtml(html: string): HtmlCounts {
  return {
    startTags: count(START_TAG, html),
    tagTokens: count(TAG_TOKEN, html),
    formattingTags: count(FORMATTING_START, html),
    detailsTags: count(DETAILS_START, html),
  };
}

export function assertSourceWithinBudget(source: string, budget: MarkdownBudget): void {
  if (source.length > budget.maxSourceChars) {
    throw new MarkdownBudgetError("the file is too large to render");
  }
}

/** Checks the markdown-it output before any DOM parse. */
export function assertHtmlWithinBudget(html: string, budget: MarkdownBudget): void {
  const counts = countHtml(html);
  if (counts.startTags > budget.maxStartTags) {
    throw new MarkdownBudgetError("the file has too many HTML elements to render");
  }
  if (counts.detailsTags > budget.maxDetailsTags) {
    throw new MarkdownBudgetError("the file has too many collapsible sections to render");
  }
  if (counts.formattingTags !== 0) {
    // standInFormattingTags should have renamed every one of these.
    throw new MarkdownRenderError("formatting tags reached the parser");
  }
}

/** Checks the sanitized body before the second parse. */
export function assertBodyWithinBudget(bodyHtml: string, budget: MarkdownBudget): void {
  if (bodyHtml.length > budget.maxBodyChars) {
    throw new MarkdownBudgetError("the rendered file is too large to show");
  }
}
