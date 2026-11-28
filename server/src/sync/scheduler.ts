import type { ResolvedSettings, SyncErrorKind, SyncRun } from "@amber/shared";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";
import {
  CAP_CEILING_ERROR,
  CAP_REACHED_ERROR,
  CAP_WOULD_NOT_FIT_ERROR,
  firstCloneFacts,
  isAtCapCeiling,
  markFirstCloneRefused,
  remainingAllowanceBytes,
} from "../domain/caps.ts";
import { ADMIN_ONLY_FORGE_ERROR, ownerMayUseForge } from "../domain/forges.ts";
import { resolveGlobalSettings, resolveSettings } from "../domain/settings.ts";
import { isAtOrOverCap } from "../domain/users.ts";
import { lookupRepoInfo } from "../providers/forks.ts";
import type { RepoInfo } from "../providers/types.ts";
import { createConsoleLogger } from "../logging.ts";
import { jitteredIntervalMs } from "./backoff.ts";
import {
  DISK_FLOOR_ERROR,
  isBelowDiskFloor,
  minFreeBytesFor,
  type FreeBytesProbe,
} from "./diskWatch.ts";
import { shutdownGit } from "./gitCli.ts";
import {
  countForgesWithRepos,
  forgeIdForRepo,
  listDueRepos,
  nextDueAt,
  setNextSyncAt,
} from "./repoStore.ts";
import type {
  CredentialResolver,
  SettingsResolver,
  SyncEventPublisher,
  SyncRepoDeps,
} from "./syncRepo.ts";
import { syncRepo } from "./syncRepo.ts";

export { backoffDelayMs, jitteredIntervalMs } from "./backoff.ts";

export interface SchedulerStatus {
  queueDepth: number;
  activeSyncs: number;
  breakerOpen: boolean;
}

export interface SchedulerOptions {
  db: Db;
  backupsDir: string;
  logger?: Logger;
  stateDir?: string;
  events?: SyncEventPublisher;
  secretKey?: Buffer | null;
  settings?: SettingsResolver;
  globalSettings?: (db: Db) => ResolvedSettings;
  credentials?: CredentialResolver;
  /** Injected by the tests so scheduling can be exercised without git. */
  runSync?: (deps: SyncRepoDeps) => Promise<SyncRun>;
  now?: () => number;
  random?: () => number;
  /** How often the queue is re-read from the database. */
  refreshIntervalMs?: number;
  /** Spacing between the first syncs of a startup batch. */
  staggerStepMs?: number;
  /** Total window the startup batch is spread over. */
  staggerWindowMs?: number;
  /** How long stop() waits for running syncs before killing git. */
  shutdownGraceMs?: number;
  allowFileProtocol?: boolean;
  /** Test seam: free bytes on the backups volume (statfs by default). */
  freeDiskBytes?: FreeBytesProbe;
  /** Test seam: the in-sync disk guard's poll interval and probes. */
  diskWatch?: SyncRepoDeps["diskWatch"];
  /**
   * Asks the forge about one repository right before a capped owner's first
   * clone, for its size (and, while at it, its visibility). Injectable so the
   * tests never reach a forge. Null: nothing could be learned.
   */
  repoInfo?: (db: Db, repoId: number) => Promise<RepoInfo | null>;
}

/** Five failed attempts across different forges mean the problem is local. */
export const BREAKER_FAILURE_THRESHOLD = 5;
export const BREAKER_BASE_PAUSE_MS = 60_000;
export const BREAKER_MAX_PAUSE_MS = 10 * 60_000;

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_STAGGER_STEP_MS = 2000;
const DEFAULT_STAGGER_WINDOW_MS = 5 * 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

interface QueueEntry {
  repoId: number;
  forgeId: number;
  dueAt: number;
  manual: boolean;
  seq: number;
}

class MinHeap {
  readonly #items: QueueEntry[] = [];

  get size(): number {
    return this.#items.length;
  }

  get items(): readonly QueueEntry[] {
    return this.#items;
  }

  push(entry: QueueEntry): void {
    this.#items.push(entry);
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.#less(index, parent)) {
        this.#swap(index, parent);
        index = parent;
      } else {
        break;
      }
    }
  }

  pop(): QueueEntry | undefined {
    const top = this.#items[0];
    const last = this.#items.pop();
    if (this.#items.length > 0 && last !== undefined) {
      this.#items[0] = last;
      this.#sink(0);
    }
    return top;
  }

  peek(): QueueEntry | undefined {
    return this.#items[0];
  }

  /**
   * Move a queued repo to the front as a manual run. Decreasing a key can
   * violate the heap anywhere, and the queue is only ever as long as the repo
   * list, so it is rebuilt rather than carrying an index for a rare operation.
   */
  promote(repoId: number): boolean {
    const target = this.#items.find((entry) => entry.repoId === repoId);
    if (target === undefined) {
      return false;
    }
    target.dueAt = 0;
    target.manual = true;
    const all = this.#items.splice(0, this.#items.length);
    for (const entry of all) {
      this.push(entry);
    }
    return true;
  }

  #sink(start: number): void {
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.#items.length && this.#less(left, smallest)) {
        smallest = left;
      }
      if (right < this.#items.length && this.#less(right, smallest)) {
        smallest = right;
      }
      if (smallest === index) {
        return;
      }
      this.#swap(index, smallest);
      index = smallest;
    }
  }

  #less(a: number, b: number): boolean {
    const left = this.#items[a];
    const right = this.#items[b];
    if (left === undefined || right === undefined) {
      return false;
    }
    return left.dueAt === right.dueAt ? left.seq < right.seq : left.dueAt < right.dueAt;
  }

  #swap(a: number, b: number): void {
    const left = this.#items[a];
    const right = this.#items[b];
    if (left !== undefined && right !== undefined) {
      this.#items[a] = right;
      this.#items[b] = left;
    }
  }
}

/**
 * Persistent schedule driven by repos.next_sync_at, an in-memory min-heap, a
 * worker pool capped by max_concurrent_syncs, a per-forge cap, exponential
 * backoff with full jitter, and a cross-forge network circuit breaker.
 *
 * Backoff itself is persisted by syncRepo (it writes next_sync_at), so a
 * restart resumes exactly where the previous process left off instead of
 * hammering a forge that is already unhappy.
 */
export class Scheduler {
  readonly #options: SchedulerOptions;
  readonly #log: Logger;
  readonly #heap = new MinHeap();
  readonly #queued = new Set<number>();
  readonly #running = new Map<number, Promise<void>>();
  readonly #runningForge = new Map<number, number>();
  /** Capped owners with a first clone in flight: theirs run one at a time. */
  readonly #firstCloneOwners = new Set<number>();
  #seq = 0;
  #timer: NodeJS.Timeout | undefined;
  #started = false;
  #stopping = false;

  #lastPublishedStatus: SchedulerStatus | undefined;

  #breakerWindow: { forgeId: number }[] = [];
  #breakerOpenUntil = 0;
  #breakerPauseMs = BREAKER_BASE_PAUSE_MS;
  #breakerProbing = false;

  constructor(options: SchedulerOptions) {
    this.#options = options;
    this.#log = (options.logger ?? createConsoleLogger("silent")).child({ mod: "scheduler" });
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#stopping = false;
    // Startup catch-up: everything overdue is queued exactly once, staggered so
    // a two day outage does not turn into a thundering herd on the first tick.
    this.#refresh(true);
    this.#pump();
    this.#arm();
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const grace = this.#options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    const running = [...this.#running.values()];
    if (running.length > 0) {
      this.#log.info({ active: running.length }, "waiting for in flight syncs");
      let timer: NodeJS.Timeout | undefined;
      const expired = await Promise.race([
        Promise.allSettled(running).then(() => false),
        new Promise<boolean>((done) => {
          timer = setTimeout(() => {
            done(true);
          }, grace);
          timer.unref?.();
        }),
      ]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (expired) {
        this.#log.warn("in flight syncs outlived the shutdown grace period, killing git");
      }
    }
    await shutdownGit();
  }

  /** Manual sync: jumps the queue. */
  enqueueNow(repoId: number): void {
    if (this.#running.has(repoId)) {
      // Already syncing; the caller is getting what it asked for.
      return;
    }
    if (this.#queued.has(repoId)) {
      // Already waiting, but possibly hours out and as a scheduled run. Promote
      // it so "sync now" means now, and so it ignores sync_enabled.
      this.#heap.promote(repoId);
      this.#pump();
      this.#arm();
      return;
    }
    const forgeId = forgeIdForRepo(this.#options.db, repoId);
    if (forgeId === undefined) {
      this.#log.warn({ repoId }, "sync now requested for a repo that does not exist");
      return;
    }
    this.#enqueue({ repoId, forgeId, dueAt: 0, manual: true, seq: (this.#seq += 1) });
    this.#pump();
    this.#arm();
  }

  status(): SchedulerStatus {
    return {
      queueDepth: this.#heap.size,
      activeSyncs: this.#running.size,
      breakerOpen: this.#now() < this.#breakerOpenUntil,
    };
  }

  /** Test seam: run one scheduling pass without waiting for the timer. */
  tick(): void {
    if (this.#stopping) {
      return;
    }
    this.#refresh(false);
    this.#pump();
    this.#arm();
  }

  // -------------------------------------------------------------------------

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #globals(): ResolvedSettings {
    return (this.#options.globalSettings ?? resolveGlobalSettings)(this.#options.db);
  }

  #settingsFor(repoId: number): ResolvedSettings {
    return (this.#options.settings ?? resolveSettings)(this.#options.db, repoId);
  }

  #enqueue(entry: QueueEntry): void {
    this.#heap.push(entry);
    this.#queued.add(entry.repoId);
  }

  #refresh(startup: boolean): void {
    const now = this.#now();
    const due = listDueRepos(this.#options.db, now);
    const step = this.#options.staggerStepMs ?? DEFAULT_STAGGER_STEP_MS;
    const window = this.#options.staggerWindowMs ?? DEFAULT_STAGGER_WINDOW_MS;
    const spacing = due.length > 1 ? Math.min(step, Math.floor(window / due.length)) : 0;

    let position = 0;
    for (const repo of due) {
      // One repo is one row is one queue entry, so a long outage produces a
      // single catch-up fetch rather than one per missed interval.
      if (this.#queued.has(repo.id) || this.#running.has(repo.id)) {
        continue;
      }
      const dueAt = startup ? now + position * spacing : (repo.nextSyncAt ?? now);
      this.#enqueue({
        repoId: repo.id,
        forgeId: repo.forgeId,
        dueAt,
        manual: false,
        seq: (this.#seq += 1),
      });
      position += 1;
    }
  }

  #pump(): void {
    if (this.#stopping) {
      return;
    }
    const globals = this.#globals();
    const maxTotal = globals.max_concurrent_syncs;
    const maxPerForge = globals.max_concurrent_per_forge;
    const deferred: QueueEntry[] = [];

    while (this.#running.size < maxTotal) {
      const now = this.#now();
      const head = this.#heap.peek();
      if (head === undefined || head.dueAt > now) {
        break;
      }
      if (!this.#breakerAllows(now)) {
        break;
      }
      const entry = this.#heap.pop();
      if (entry === undefined) {
        break;
      }
      if (this.#running.has(entry.repoId)) {
        // Belt and braces: one repo is one queue entry, so this should be
        // impossible, and a double dispatch would fetch into the same directory
        // twice at once.
        this.#queued.delete(entry.repoId);
        continue;
      }
      const forgeCount = [...this.#runningForge.values()].filter(
        (forgeId) => forgeId === entry.forgeId,
      ).length;
      if (forgeCount >= maxPerForge) {
        // The forge is saturated; leave the entry queued and try the next one.
        deferred.push(entry);
        continue;
      }
      const cappedOwner = this.#cappedFirstCloneOwner(entry.repoId);
      if (cappedOwner !== null && this.#firstCloneOwners.has(cappedOwner)) {
        // A capped user's first clones run one at a time: sizes are only
        // known after a clone, so a batch would otherwise all pass the cap.
        deferred.push(entry);
        continue;
      }
      this.#queued.delete(entry.repoId);
      this.#start(entry);
    }

    for (const entry of deferred) {
      this.#heap.push(entry);
    }
  }

  #start(entry: QueueEntry): void {
    const settings = this.#settingsFor(entry.repoId);
    if (!settings.sync_enabled && !entry.manual) {
      // Push the row out of the due window so it does not spin on every refresh.
      const next =
        this.#now() +
        jitteredIntervalMs(settings.sync_interval_minutes * 60_000, this.#options.random);
      setNextSyncAt(this.#options.db, entry.repoId, next, this.#now());
      return;
    }

    this.#runningForge.set(entry.repoId, entry.forgeId);
    const cappedOwner = this.#cappedFirstCloneOwner(entry.repoId);
    if (cappedOwner !== null) {
      this.#firstCloneOwners.add(cappedOwner);
    }
    const run = this.#firstCloneGate(entry.repoId, settings)
      .then(async (allowed) => {
        if (!allowed) {
          // Not a sync and not a failure: it must not feed the breaker.
          return;
        }
        this.#recordOutcome(entry.forgeId, await this.#execute(entry));
      })
      .catch((cause: unknown) => {
        this.#log.error({ repoId: entry.repoId, err: cause }, "sync threw outside the run record");
        this.#recordOutcome(entry.forgeId, "other");
      })
      .finally(() => {
        this.#running.delete(entry.repoId);
        this.#runningForge.delete(entry.repoId);
        if (cappedOwner !== null) {
          this.#firstCloneOwners.delete(cappedOwner);
        }
        if (!this.#stopping) {
          this.#pump();
          this.#arm();
        }
      });
    this.#running.set(entry.repoId, run);
  }

  /** The owner, when this repo's next sync is a capped (non-admin) owner's first clone. */
  #cappedFirstCloneOwner(repoId: number): number | null {
    const facts = firstCloneFacts(this.#options.db, repoId);
    return facts.firstClone && facts.cappedOwner !== null ? facts.cappedOwner.id : null;
  }

  /**
   * THE FIRST-CLONE GATE (docs/ARCHITECTURE.md "Storage caps"). Right before
   * a capped owner's never-synced repo starts its first clone: at or over the
   * cap, it does not start; where the forge reports a size that would not fit
   * the remaining allowance, it does not start either. Both mark the repo
   * "storage cap reached" and retry on its normal schedule. Manual syncs go
   * through here too. An unknown size lets the clone proceed. A renamed repo
   * counts as a first clone (firstCloneFacts), and the twice-the-cap ceiling
   * is checked here for EVERY sync of a capped owner.
   */
  async #firstCloneGate(repoId: number, settings: ResolvedSettings): Promise<boolean> {
    const { db } = this.#options;
    const facts = firstCloneFacts(db, repoId);
    const owner = facts.cappedOwner;
    const refuse = (message: string): false => {
      const now = this.#now();
      const retryAt =
        now + jitteredIntervalMs(settings.sync_interval_minutes * 60_000, this.#options.random);
      markFirstCloneRefused(db, repoId, message, retryAt, now);
      this.#log.info({ repoId, ownerUserId: owner?.id ?? null }, "sync refused before it started");
      this.#options.events?.publish("repo.updated", { repoId });
      return false;
    };
    // THE FREE-SPACE FLOOR, for every sync, the admin's included: a full
    // volume would stop SQLite and take the whole instance down. The running
    // sync is watched too (sync/diskWatch.ts); this keeps one from starting.
    const minFreeBytes = minFreeBytesFor(settings.min_free_disk_gb);
    if (
      minFreeBytes > 0 &&
      (await isBelowDiskFloor(this.#options.backupsDir, minFreeBytes, this.#options.freeDiskBytes))
    ) {
      return refuse(DISK_FLOOR_ERROR);
    }
    // An unrestricted forge is the admin's alone (domain/forges.ts). Refused
    // HERE, before the size lookup below, which would otherwise call the
    // forge's API from Amber's LAN position on a non-admin's behalf.
    const forgeRow = db.get<{ allow_private_network: number; owner_user_id: number | null }>(
      `SELECT f.allow_private_network, r.owner_user_id
         FROM repos r JOIN forges f ON f.id = r.forge_id WHERE r.id = ?`,
      repoId,
    );
    if (
      forgeRow !== undefined &&
      !ownerMayUseForge(db, forgeRow.owner_user_id, {
        allowPrivateNetwork: forgeRow.allow_private_network === 1,
      })
    ) {
      return refuse(ADMIN_ONLY_FORGE_ERROR);
    }
    if (owner === null) {
      return true;
    }
    // THE HARD CEILING (domain/caps.ts isAtCapCeiling), for every sync of a
    // capped owner's repo, not only first clones. Refused like the gate below:
    // no run row, so no backoff growth and no breaker effect, retried on the
    // normal schedule.
    if (isAtCapCeiling(db, owner)) {
      return refuse(CAP_CEILING_ERROR);
    }
    if (!facts.firstClone) {
      return true;
    }
    if (isAtOrOverCap(db, owner)) {
      return refuse(CAP_REACHED_ERROR);
    }
    let info: RepoInfo | null = null;
    try {
      info = await (this.#options.repoInfo ?? this.#defaultRepoInfo)(db, repoId);
    } catch (error) {
      // Not knowing the size is not a reason to refuse.
      this.#log.debug({ repoId, err: error }, "could not ask the forge for a repository size");
    }
    const remaining = remainingAllowanceBytes(db, owner);
    if (
      info !== null &&
      info.sizeBytes !== null &&
      remaining !== null &&
      info.sizeBytes > remaining
    ) {
      return refuse(CAP_WOULD_NOT_FIT_ERROR);
    }
    return true;
  }

  readonly #defaultRepoInfo = (db: Db, repoId: number): Promise<RepoInfo | null> =>
    lookupRepoInfo(db, repoId, {
      secretKey: this.#options.secretKey ?? null,
      ...(this.#options.logger === undefined ? {} : { log: this.#options.logger }),
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
    });

  async #execute(entry: QueueEntry): Promise<SyncErrorKind | null> {
    const runner = this.#options.runSync ?? syncRepo;
    const run = await runner({
      repoId: entry.repoId,
      manual: entry.manual,
      db: this.#options.db,
      backupsDir: this.#options.backupsDir,
      stateDir: this.#options.stateDir,
      logger: this.#options.logger,
      events: this.#options.events,
      secretKey: this.#options.secretKey,
      settings: this.#options.settings,
      credentials: this.#options.credentials,
      allowFileProtocol: this.#options.allowFileProtocol,
      ...(this.#options.diskWatch === undefined ? {} : { diskWatch: this.#options.diskWatch }),
      now: this.#options.now,
      random: this.#options.random,
    });
    return run.outcome === "success" ? null : run.errorKind;
  }

  // -------------------------------------------------------------------------
  // Circuit breaker
  // -------------------------------------------------------------------------

  #breakerAllows(now: number): boolean {
    if (this.#breakerOpenUntil === 0) {
      return true;
    }
    if (now < this.#breakerOpenUntil) {
      return false;
    }
    if (this.#breakerProbing) {
      // A probe is already out; nothing else moves until it comes back.
      return false;
    }
    this.#breakerProbing = true;
    this.#log.info("network circuit breaker is probing with a single sync");
    return true;
  }

  #recordOutcome(forgeId: number, kind: SyncErrorKind | null): void {
    const networkish = kind === "network" || kind === "timeout";
    if (kind === null) {
      this.#breakerWindow = [];
      if (this.#breakerOpenUntil !== 0) {
        this.#log.info("network circuit breaker closed");
      }
      this.#breakerOpenUntil = 0;
      this.#breakerPauseMs = BREAKER_BASE_PAUSE_MS;
      this.#breakerProbing = false;
      return;
    }
    if (!networkish) {
      // A 404 or an auth failure says the network is fine, so the window that
      // would have tripped the breaker is no longer evidence of anything.
      this.#breakerWindow = [];
      this.#breakerProbing = false;
      return;
    }

    if (this.#breakerProbing) {
      this.#breakerProbing = false;
      this.#breakerPauseMs = Math.min(this.#breakerPauseMs * 2, BREAKER_MAX_PAUSE_MS);
      this.#breakerOpenUntil = this.#now() + this.#breakerPauseMs;
      this.#breakerWindow = [];
      this.#log.warn({ pauseMs: this.#breakerPauseMs }, "network circuit breaker reopened");
      return;
    }

    this.#breakerWindow.push({ forgeId });
    if (this.#breakerWindow.length > BREAKER_FAILURE_THRESHOLD) {
      this.#breakerWindow.shift();
    }
    if (this.#breakerWindow.length < BREAKER_FAILURE_THRESHOLD) {
      return;
    }
    const distinct = new Set(this.#breakerWindow.map((item) => item.forgeId)).size;
    // Failures spread across forges mean the local network is gone. On a single
    // forge deployment there is nothing to spread across, so the count alone
    // has to be enough.
    const needed = Math.min(2, Math.max(1, countForgesWithRepos(this.#options.db)));
    if (distinct < needed) {
      return;
    }
    this.#breakerOpenUntil = this.#now() + this.#breakerPauseMs;
    this.#breakerWindow = [];
    this.#breakerProbing = false;
    this.#log.warn(
      { pauseMs: this.#breakerPauseMs, forges: distinct },
      "network circuit breaker opened",
    );
  }

  // -------------------------------------------------------------------------

  /**
   * Push the queue counters out over SSE so the header does not have to poll.
   *
   * Called from #arm, which runs after every state change (start, enqueue,
   * tick, and each finished run), and deduped against the last published
   * triple: an idle instance re-arms its timer constantly and must not turn
   * that into a stream of identical events.
   */
  #publishStatus(): void {
    const next = this.status();
    const last = this.#lastPublishedStatus;
    if (
      last !== undefined &&
      last.queueDepth === next.queueDepth &&
      last.activeSyncs === next.activeSyncs &&
      last.breakerOpen === next.breakerOpen
    ) {
      return;
    }
    this.#lastPublishedStatus = next;
    this.#options.events?.publish("status.changed", { ...next });
  }

  #arm(): void {
    if (this.#stopping || !this.#started) {
      return;
    }
    this.#publishStatus();
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const now = this.#now();
    const refresh = this.#options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    let wake = now + refresh;

    const head = this.#heap.peek();
    if (head !== undefined && head.dueAt > now) {
      wake = Math.min(wake, head.dueAt);
    }
    if (this.#breakerOpenUntil > now) {
      wake = Math.min(wake, this.#breakerOpenUntil);
    }
    const upcoming = nextDueAt(this.#options.db, now);
    if (upcoming !== undefined) {
      wake = Math.min(wake, upcoming);
    }

    const delay = Math.max(1, wake - now);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.tick();
    }, delay);
    this.#timer.unref?.();
  }
}
