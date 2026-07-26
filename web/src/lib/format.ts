/** Display helpers. Pure functions so the component tests can assert on them. */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Human-readable byte size, 1024-based. Null renders as a dash. */
export function humanBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "-";
  if (bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Coarse relative time: "just now", "5 min ago", "in 2 h". Deliberately
 * low-resolution - the table refreshes on its own and second-level precision
 * would only ever be wrong.
 */
export function relativeTime(at: number | null | undefined, now = Date.now()): string {
  if (at === null || at === undefined) return "never";
  const delta = at - now;
  const magnitude = Math.abs(delta);
  if (magnitude < 45_000) return "just now";

  const [amount, unit] =
    magnitude < HOUR
      ? [Math.round(magnitude / MINUTE), "min"]
      : magnitude < DAY
        ? [Math.round(magnitude / HOUR), "h"]
        : magnitude < 30 * DAY
          ? [Math.round(magnitude / DAY), "d"]
          : [Math.round(magnitude / (30 * DAY)), "mo"];

  return delta < 0 ? `${amount} ${unit} ago` : `in ${amount} ${unit}`;
}

/** Full timestamp for tooltips and detail views. */
export function absoluteTime(at: number | null | undefined): string {
  if (at === null || at === undefined) return "never";
  return new Date(at).toLocaleString();
}

/** Elapsed milliseconds as "820 ms", "4.2 s", "3 min 05 s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
}

/** "https://host:8080" for a forge, with default ports left implicit. */
export function forgeOrigin(forge: {
  protocol: string;
  host: string;
  port: number | null;
}): string {
  const port = forge.port === null ? "" : `:${forge.port}`;
  return `${forge.protocol}://${forge.host}${port}`;
}

/** Sanitize a display name for use as a downloaded file name. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "amber-export" : cleaned;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? `${count} ${singular}` : `${count} ${plural}`;
}
