import type { CreateForge, Forge, ForgeKind, ForgeProtocol, UpdateForge } from "@amber/shared";
import type { Db } from "../db/db.ts";
import {
  conflict,
  DomainError,
  forbidden,
  isForeignKeyViolation,
  isUniqueViolation,
  notFound,
} from "./errors.ts";
import type { User } from "./users.ts";

/**
 * A forge is an origin: protocol, host, port. Those three are IMMUTABLE after
 * create, and that is a security property rather than a convenience. Someone
 * who could edit a forge's host would be able to point an existing account's
 * stored credential at a host they control. Changing a host means creating a
 * new forge, which starts with no credentials. Only `kind` is editable.
 */

interface ForgeRow {
  id: number;
  protocol: string;
  host: string;
  port: number | null;
  kind: string;
  allow_private_network: number;
  created_at: number;
  updated_at: number;
}

const FORGE_COLUMNS =
  "id, protocol, host, port, kind, allow_private_network, created_at, updated_at";

function toForge(row: ForgeRow): Forge {
  return {
    id: row.id,
    protocol: row.protocol as Forge["protocol"],
    host: row.host,
    port: row.port,
    kind: row.kind as ForgeKind,
    allowPrivateNetwork: row.allow_private_network === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Hosts whose forge software we can identify without asking. */
const KNOWN_HOSTS: Readonly<Record<string, ForgeKind>> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
};

/** github.com -> github, gitlab.com -> gitlab, bitbucket.org -> bitbucket. */
export function detectForgeKind(host: string): ForgeKind {
  return KNOWN_HOSTS[host.trim().toLowerCase()] ?? "generic";
}

/** Hosts are compared lowercased, so one origin cannot become two forges. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/**
 * The default port for a protocol is stored as NULL, so https://host and
 * https://host:443 resolve to the same forge.
 */
export function normalizePort(protocol: string, port: number | null | undefined): number | null {
  if (port === null || port === undefined) {
    return null;
  }
  if ((protocol === "https" && port === 443) || (protocol === "http" && port === 80)) {
    return null;
  }
  return port;
}

export function listForges(db: Db): Forge[] {
  return db
    .all<ForgeRow>(`SELECT ${FORGE_COLUMNS} FROM forges ORDER BY host ASC, id ASC`)
    .map(toForge);
}

export function getForge(db: Db, id: number): Forge | undefined {
  const row = db.get<ForgeRow>(`SELECT ${FORGE_COLUMNS} FROM forges WHERE id = ?`, id);
  return row === undefined ? undefined : toForge(row);
}

export function requireForge(db: Db, id: number): Forge {
  const forge = getForge(db, id);
  if (forge === undefined) {
    throw notFound("Forge", id);
  }
  return forge;
}

/** Look an origin up without creating it. */
export function findForge(
  db: Db,
  protocol: string,
  host: string,
  port: number | null,
): Forge | undefined {
  const normalizedHost = normalizeHost(host);
  const normalizedPort = normalizePort(protocol, port);
  const row =
    normalizedPort === null
      ? db.get<ForgeRow>(
          `SELECT ${FORGE_COLUMNS} FROM forges WHERE protocol = ? AND host = ? AND port IS NULL`,
          protocol,
          normalizedHost,
        )
      : db.get<ForgeRow>(
          `SELECT ${FORGE_COLUMNS} FROM forges WHERE protocol = ? AND host = ? AND port = ?`,
          protocol,
          normalizedHost,
          normalizedPort,
        );
  return row === undefined ? undefined : toForge(row);
}

// ---------------------------------------------------------------------------
// Who may introduce a host
// ---------------------------------------------------------------------------

export interface ForgeOrigin {
  protocol: ForgeProtocol;
  host: string;
  port: number | null;
}

/** The message a caller who may not add a host gets, by import or by the forges API. */
export const HOST_NOT_ENABLED_MESSAGE = "This host is not enabled on this Amber.";

/** Introducing a NEW host is an access-control decision: manage_forges or the admin. */
export function mayAddForges(user: User): boolean {
  return user.isAdmin || user.permissions.manage_forges;
}

export function hostNotEnabled(): DomainError {
  return new DomainError("host_not_enabled", HOST_NOT_ENABLED_MESSAGE);
}

/**
 * `allow_private_network` lets requests to a forge reach non-public
 * addresses, so only the admin may set it. Anyone else asking for it is
 * refused rather than having the flag silently dropped.
 */
export function assertMaySetPrivateNetwork(user: User, wanted: boolean | undefined): void {
  if (wanted === true && !user.isAdmin) {
    throw forbidden("Only the admin can allow a forge to reach private networks.", {
      requires: "admin",
    });
  }
}

/**
 * EGRESS SEAM. Called right before a NEW forge row is created, by the forges
 * API and by import's new-host path, outside any database transaction so it
 * may resolve DNS. Today it checks nothing: the egress wave fills it in
 * (security/egress.ts: a restricted forge must be plain https on 443 or http
 * on 80, its host must not be an IP literal, and every address it resolves
 * to must be public). It throws a DomainError to refuse.
 */
export async function assertForgeAllowed(
  origin: ForgeOrigin,
  actor: User,
  options: { allowPrivateNetwork: boolean },
): Promise<void> {
  void origin;
  void actor;
  void options;
  await Promise.resolve();
}

/**
 * Idempotent: returns the existing forge when protocol+host+port already
 * exist. An explicit kind is honored on create; on an existing forge the
 * stored kind is kept, because re-importing a URL must never silently
 * reclassify a forge the user has already corrected by hand.
 */
export function upsertForge(db: Db, input: CreateForge): Forge {
  const protocol = input.protocol;
  const host = normalizeHost(input.host);
  const port = normalizePort(protocol, input.port);
  if (host === "") {
    throw conflict("A forge needs a host.");
  }

  return db.tx(() => {
    const existing = findForge(db, protocol, host, port);
    if (existing !== undefined) {
      return existing;
    }

    const kind = input.kind ?? detectForgeKind(host);
    const now = Date.now();
    let id: number;
    try {
      // Restricted unless asked otherwise. Whether the caller MAY ask is the
      // route's check (assertMaySetPrivateNetwork); the default is closed.
      id = db.run(
        `INSERT INTO forges (protocol, host, port, kind, allow_private_network, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        protocol,
        host,
        port,
        kind,
        input.allowPrivateNetwork === true ? 1 : 0,
        now,
        now,
      ).lastInsertRowid;
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Lost a race against another writer; the winner's row is what we want.
        const raced = findForge(db, protocol, host, port);
        if (raced !== undefined) {
          return raced;
        }
      }
      throw error;
    }
    return requireForge(db, id);
  });
}

/**
 * Only `kind` may change. protocol, host, and port are deliberately never read
 * from the patch: UpdateForge declares no such fields and this function never
 * writes them, so no API path can reach a host change.
 */
export function updateForge(db: Db, id: number, patch: UpdateForge): Forge {
  return db.tx(() => {
    const existing = requireForge(db, id);
    const now = Date.now();
    let changed = false;
    if (patch.kind !== undefined && patch.kind !== existing.kind) {
      db.run("UPDATE forges SET kind = ?, updated_at = ? WHERE id = ?", patch.kind, now, id);
      changed = true;
    }
    if (
      patch.allowPrivateNetwork !== undefined &&
      patch.allowPrivateNetwork !== existing.allowPrivateNetwork
    ) {
      db.run(
        "UPDATE forges SET allow_private_network = ?, updated_at = ? WHERE id = ?",
        patch.allowPrivateNetwork ? 1 : 0,
        now,
        id,
      );
      changed = true;
    }
    return changed ? requireForge(db, id) : existing;
  });
}

/**
 * Accounts cascade away with the forge. Repos are ON DELETE RESTRICT, so a
 * forge that still backs up repositories cannot be removed by accident.
 */
export function deleteForge(db: Db, id: number): void {
  db.tx(() => {
    requireForge(db, id);
    const repoCount = db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM repos WHERE forge_id = ?",
      id,
    );
    if (repoCount !== undefined && repoCount.count > 0) {
      throw conflict(
        `This forge still has ${String(repoCount.count)} repositories. Delete them first.`,
        { repoCount: repoCount.count },
      );
    }
    try {
      db.run("DELETE FROM forges WHERE id = ?", id);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw conflict("This forge is still referenced by other records.");
      }
      throw error;
    }
  });
}
