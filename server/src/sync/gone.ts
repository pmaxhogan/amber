import {
  dmcaTakedown,
  GONE_AFTER_FAILURES,
  GONE_CONFIRM_MS,
  GONE_ERROR_KINDS,
  type GoneReason,
  type SyncErrorKind,
} from "@amber/shared";

/**
 * Deciding that a repository is gone upstream. Pure, so the rule can be read
 * and tested without a sync around it; syncRepo.ts gathers the facts.
 */

export interface GoneFacts {
  /** How the run that just finished failed. Null when it did not. */
  errorKind: SyncErrorKind | null;
  /** What git printed, already scrubbed of credentials. */
  error: string | null;
  forgeKind: string;
  lastSuccessAt: number | null;
  /** Set when the repository is already gone; it cannot go gone twice. */
  goneAt: number | null;
  /** Failures in a row, this run included. */
  consecutiveFailures: number;
  /**
   * When the unbroken run of not-found or access-denied answers this failure
   * belongs to began. The run's own start time when it is the first of them.
   */
  unreachableSince: number;
  now: number;
}

function isGoneKind(kind: SyncErrorKind | null): kind is (typeof GONE_ERROR_KINDS)[number] {
  return kind !== null && (GONE_ERROR_KINDS as readonly string[]).includes(kind);
}

/**
 * The reason this failure makes the repository gone, or null when it does not.
 *
 * Gone means it synced before and the forge now says it is not there (or not
 * ours to read, which is what a deleted or newly private repository looks like
 * to an anonymous fetch), and has kept saying so for GONE_CONFIRM_MS. Forges
 * hide public repositories for hours and bring them back, so neither one
 * answer nor a handful of retries minutes apart proves anything.
 *
 * A GitHub DMCA takedown needs no such patience: the forge has said outright
 * that the repository was removed, and why.
 */
export function judgeGone(facts: GoneFacts): GoneReason | null {
  if (!isGoneKind(facts.errorKind) || facts.lastSuccessAt === null || facts.goneAt !== null) {
    return null;
  }
  if (dmcaTakedown(facts.forgeKind, facts.error) !== null) {
    return "dmca_takedown";
  }
  const confirmed =
    facts.consecutiveFailures >= GONE_AFTER_FAILURES &&
    facts.now - facts.unreachableSince >= GONE_CONFIRM_MS;
  return confirmed ? facts.errorKind : null;
}
