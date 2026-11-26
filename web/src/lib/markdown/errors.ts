/** Every failure to render markdown safely. Callers show the source as text. */
export class MarkdownRenderError extends Error {
  override name = "MarkdownRenderError";
}

/** The file is over a work limit (see budget.ts). Also a MarkdownRenderError. */
export class MarkdownBudgetError extends MarkdownRenderError {
  override name = "MarkdownBudgetError";
}
