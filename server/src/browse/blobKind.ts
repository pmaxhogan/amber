import { BROWSE_MAX_TEXT_BYTES, browseInlineImageType } from "@amber/shared";
import { runGitOk, type GitCtx } from "./gitRun.ts";

/**
 * What a file really is, decided from its bytes and never from its name alone.
 * `contents` (which picks the viewer) and `raw` (which decides whether the
 * bytes may be served as an image) both go through matchInlineImage, so they
 * cannot disagree about it.
 */

/** Bytes inspected for a NUL. The same window git uses to call a file binary. */
export const BINARY_SNIFF_BYTES = 8000;
/** Head read for a file too large to send as text. A few bytes past the window, so a UTF-8 cut is visible. */
export const HEAD_READ_BYTES = 8192;

const SVG_ROOT = /<(?:[A-Za-z_][\w.-]*:)?svg[\s>/]/i;

function startsWith(bytes: Buffer, offset: number, signature: readonly number[]): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Buffer, start: number, end: number): string {
  return bytes.subarray(start, end).toString("latin1");
}

/** The image type the first bytes announce, for the raster formats. */
export function sniffRasterType(head: Buffer): string | null {
  if (startsWith(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(head, 0, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  const gif = ascii(head, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") {
    return "image/gif";
  }
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (brand === "avif" || brand === "avis") {
      return "image/avif";
    }
  }
  if (startsWith(head, 0, [0x42, 0x4d])) {
    return "image/bmp";
  }
  if (startsWith(head, 0, [0x00, 0x00, 0x01, 0x00])) {
    return "image/x-icon";
  }
  return null;
}

/**
 * Whether `bytes` is valid UTF-8. When `partial` is set the buffer was cut off
 * mid-file, so up to three trailing bytes may be the start of a character.
 */
export function isUtf8(bytes: Buffer, partial: boolean): boolean {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const attempts = partial ? 4 : 1;
  for (let cut = 0; cut < attempts && cut <= bytes.length; cut += 1) {
    try {
      decoder.decode(bytes.subarray(0, bytes.length - cut));
      return true;
    } catch {
      // Try one byte shorter.
    }
  }
  return false;
}

/** Binary: a NUL in the first window, or bytes that are not UTF-8. */
export function looksBinary(bytes: Buffer, partial: boolean): boolean {
  const window = bytes.subarray(0, BINARY_SNIFF_BYTES);
  return window.includes(0) || !isUtf8(bytes, partial);
}

/**
 * The image type to serve `path` as, or null. The type comes from the
 * extension and the bytes must agree: a raster file by its magic number, an SVG
 * only when the whole file is UTF-8 text with an svg element in it. `complete`
 * says whether `bytes` is the whole file.
 */
export function matchInlineImage(path: string, bytes: Buffer, complete: boolean): string | null {
  const type = browseInlineImageType(path);
  if (type === null) {
    return null;
  }
  if (type === "image/svg+xml") {
    if (!complete || bytes.includes(0) || !isUtf8(bytes, false)) {
      return null;
    }
    return SVG_ROOT.test(bytes.toString("utf8")) ? type : null;
  }
  return sniffRasterType(bytes) === type ? type : null;
}

/** Read up to `maxBytes` of a blob. `truncated` says there was more. */
export async function readBlob(
  ctx: GitCtx,
  oid: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const result = await runGitOk(ctx, ["cat-file", "blob", oid], { maxBytes });
  return { bytes: result.stdout, truncated: result.truncated };
}

/**
 * Check a stored file against its extension's image type, reading only what
 * the check needs: the first bytes for a raster image, the whole file for an
 * SVG (and none of it when it is too large to treat as text).
 */
export async function verifyInlineImage(
  ctx: GitCtx,
  entry: { oid: string; size: number },
  path: string,
): Promise<string | null> {
  const type = browseInlineImageType(path);
  if (type === null) {
    return null;
  }
  if (type === "image/svg+xml") {
    if (entry.size > BROWSE_MAX_TEXT_BYTES) {
      return null;
    }
    const { bytes, truncated } = await readBlob(ctx, entry.oid, BROWSE_MAX_TEXT_BYTES);
    return matchInlineImage(path, bytes, !truncated);
  }
  const { bytes } = await readBlob(ctx, entry.oid, 32);
  return matchInlineImage(path, bytes, false);
}
