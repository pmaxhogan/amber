/**
 * Parser for the bulk import textarea. One remote per line; blank lines and
 * lines starting with `#` are ignored.
 *
 * Pure logic, no IO: it is used unchanged by the server (to commit an import)
 * and by the web UI (to render the preview table before committing).
 */

export type ImportLineStatus = "ok" | "warning" | "error";

export type SupportedProtocol = "https" | "http";

export interface ParsedRepoUrl {
  /** Always lowercase. Defaults to https when the line has no scheme. */
  protocol: SupportedProtocol;
  /** Lowercase host, without brackets for IPv6 literals. */
  host: string;
  /** null when omitted or when it equals the protocol default (80/443). */
  port: number | null;
  /**
   * Normalized repository path used as the identity key: no leading slash, no
   * trailing slash, no trailing `.git`. May contain slashes for deep paths such
   * as `pub/scm/linux/kernel/git/torvalds/linux`.
   */
  path: string;
  /**
   * The `user@` prefix, if any. Selects an existing account on the forge as the
   * repo's account override. Never creates accounts implicitly.
   */
  username: string | null;
  /** Last path segment, used as the human-facing repo name. */
  displayName: string;
  /** Credential-free URL suitable for `git remote add`. */
  canonicalUrl: string;
}

export interface ImportLineResult {
  /** The trimmed input line, echoed back so the UI can show what was parsed. */
  line: string;
  /** 1-based line number within the submitted text. */
  lineNumber: number;
  status: ImportLineStatus;
  /** Present when status is "ok" or "warning". */
  parsed?: ParsedRepoUrl;
  /** Human-facing explanation. Always present for "warning" and "error". */
  message?: string;
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
/** Hostnames, IPv4 literals, and `localhost`. IPv6 is handled separately. */
const HOST_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
const IPV6_RE = /^[0-9a-fA-F:.]+$/;

const SSH_MESSAGE = "SSH remotes are not supported yet";
const GIT_PROTOCOL_MESSAGE =
  "git:// remotes are not supported. Use the https URL for this repository";

function err(line: string, lineNumber: number, message: string): ImportLineResult {
  return { line, lineNumber, status: "error", message };
}

/** Strip a single trailing `.git`, case-insensitively. */
function stripDotGit(path: string): string {
  if (path.length >= 4 && path.slice(-4).toLowerCase() === ".git") {
    return path.slice(0, -4);
  }
  return path;
}

function buildCanonicalUrl(
  protocol: SupportedProtocol,
  host: string,
  port: number | null,
  path: string,
): string {
  const authority = host.includes(":") ? `[${host}]` : host;
  const portPart = port === null ? "" : `:${port}`;
  return `${protocol}://${authority}${portPart}/${path}`;
}

/**
 * Parse one line. Returns null for blank lines and `#` comments, which callers
 * drop entirely rather than reporting.
 */
export function parseImportLine(raw: string, lineNumber = 1): ImportLineResult | null {
  const line = raw.trim();
  if (line === "" || line.startsWith("#")) {
    return null;
  }

  let rest = line;
  let protocol: SupportedProtocol = "https";

  const schemeMatch = SCHEME_RE.exec(rest);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? "").toLowerCase();
    if (scheme === "https" || scheme === "http") {
      protocol = scheme;
    } else if (scheme === "ssh") {
      return err(line, lineNumber, SSH_MESSAGE);
    } else if (scheme === "git") {
      return err(line, lineNumber, GIT_PROTOCOL_MESSAGE);
    } else {
      return err(
        line,
        lineNumber,
        `Unsupported protocol "${scheme}". Only http and https remotes are supported`,
      );
    }
    rest = rest.slice(schemeMatch[0].length);
  }

  // Drop any query string or trailing `# comment`; neither is part of a path.
  const queryIndex = rest.search(/[?#]/);
  if (queryIndex >= 0) {
    rest = rest.slice(0, queryIndex);
  }
  rest = rest.trim();

  if (rest === "") {
    return err(line, lineNumber, "Missing host");
  }
  if (/\s/.test(rest)) {
    return err(line, lineNumber, "Unexpected whitespace. Put one repository URL per line");
  }

  // Split off a `user@` (or `user:password@`) prefix. Only an `@` that appears
  // before the first `/` is userinfo; later ones belong to the path.
  let username: string | null = null;
  const firstSlash = rest.indexOf("/");
  const authorityEnd = firstSlash === -1 ? rest.length : firstSlash;
  const atIndex = rest.lastIndexOf("@", authorityEnd - 1);
  if (atIndex >= 0) {
    const userinfo = rest.slice(0, atIndex);
    rest = rest.slice(atIndex + 1);
    if (userinfo === "") {
      return err(line, lineNumber, "Empty username before @");
    }
    if (userinfo.includes(":")) {
      return err(
        line,
        lineNumber,
        "Passwords in URLs are not supported. Add the credentials under Accounts and use the plain URL",
      );
    }
    username = userinfo;
  }

  // Separate authority (host and optional port) from the path.
  let authority: string;
  let rawPath: string;
  const slashIndex = rest.indexOf("/");
  if (slashIndex === -1) {
    authority = rest;
    rawPath = "";
  } else {
    authority = rest.slice(0, slashIndex);
    rawPath = rest.slice(slashIndex + 1);
  }

  if (authority === "") {
    return err(line, lineNumber, "Missing host");
  }

  // Host and port. `[::1]:8080` keeps the IPv6 literal intact.
  let host: string;
  let portText: string | null = null;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) {
      return err(line, lineNumber, "Unterminated IPv6 address");
    }
    host = authority.slice(1, close);
    const after = authority.slice(close + 1);
    if (after !== "") {
      if (!after.startsWith(":")) {
        return err(line, lineNumber, `Could not parse host "${authority}"`);
      }
      portText = after.slice(1);
    }
    if (!IPV6_RE.test(host)) {
      return err(line, lineNumber, `Invalid IPv6 address "${host}"`);
    }
  } else {
    const colon = authority.indexOf(":");
    if (colon === -1) {
      host = authority;
    } else {
      host = authority.slice(0, colon);
      portText = authority.slice(colon + 1);
      // `host:port/path` is a URL; `host:path` is scp syntax, which git accepts
      // for SSH only. The discriminator is whether everything between the colon
      // and the next slash is digits.
      if (!/^[0-9]+$/.test(portText)) {
        return err(line, lineNumber, SSH_MESSAGE);
      }
    }
  }

  if (host === "") {
    return err(line, lineNumber, "Missing host");
  }
  if (!authority.startsWith("[") && !HOST_RE.test(host)) {
    return err(line, lineNumber, `Invalid host "${host}"`);
  }

  let port: number | null = null;
  if (portText !== null) {
    if (!/^[0-9]+$/.test(portText)) {
      return err(line, lineNumber, `Invalid port "${portText}"`);
    }
    const parsedPort = Number(portText);
    if (parsedPort < 1 || parsedPort > 65535) {
      return err(line, lineNumber, `Port ${parsedPort} is out of range`);
    }
    const isDefault =
      (protocol === "https" && parsedPort === 443) || (protocol === "http" && parsedPort === 80);
    port = isDefault ? null : parsedPort;
  }

  // Normalize the path: drop trailing slashes, strip one trailing `.git`, then
  // collapse repeated and leading slashes.
  const withoutDotGit = stripDotGit(rawPath.replace(/\/+$/, ""));
  const segments = withoutDotGit.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return err(line, lineNumber, "Relative path segments are not allowed");
  }
  const path = segments.join("/");
  if (path === "") {
    return err(line, lineNumber, "Missing repository path");
  }

  const displayName = path.slice(path.lastIndexOf("/") + 1);
  const normalizedHost = host.toLowerCase();

  return {
    line,
    lineNumber,
    status: "ok",
    parsed: {
      protocol,
      host: normalizedHost,
      port,
      path,
      username,
      displayName,
      canonicalUrl: buildCanonicalUrl(protocol, normalizedHost, port, path),
    },
  };
}

/**
 * Parse a whole textarea. Blank lines and comments are dropped; every other
 * line yields exactly one result, keeping its original 1-based line number.
 */
export function parseImportText(text: string): ImportLineResult[] {
  const results: ImportLineResult[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const result = parseImportLine(lines[i] ?? "", i + 1);
    if (result !== null) {
      results.push(result);
    }
  }
  return results;
}

/**
 * Downgrade an "ok" result to a warning. The server uses this when a `user@`
 * prefix names an account that does not exist on the forge: the import still
 * succeeds, just without an account override.
 */
export function withWarning(result: ImportLineResult, message: string): ImportLineResult {
  if (result.status === "error") {
    return result;
  }
  return { ...result, status: "warning", message };
}

export interface ImportSummary {
  total: number;
  ok: number;
  warning: number;
  error: number;
}

export function summarizeImport(results: readonly ImportLineResult[]): ImportSummary {
  const summary: ImportSummary = { total: results.length, ok: 0, warning: 0, error: 0 };
  for (const result of results) {
    summary[result.status] += 1;
  }
  return summary;
}
