/**
 * Ref names Amber will look up or hand to git as an argument. Deliberately
 * narrower than git's own rules: no leading dash (which git would read as a
 * flag), no "..", no trailing slash, no whitespace, no shell or pathspec
 * metacharacters. A ref that fails this check never becomes a positional
 * argument, so a malicious forge cannot smuggle an option through a branch name.
 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export function isPlausibleRef(ref: string): boolean {
  return REF_PATTERN.test(ref) && !ref.includes("..") && !ref.endsWith("/");
}
