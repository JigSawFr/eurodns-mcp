import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { ROTATED_SUFFIX, type RiskClass } from './constants.js';
import { hashLine, type AuditVerdict } from './audit.js';

/** One line of the audit log, as written by AuditLogger. */
export interface AuditEntry {
  ts: string;
  correlationId: string;
  phase: 'started' | 'completed';
  actor: { mode: string; subject: string; clientId?: string };
  tool: string;
  risk: RiskClass;
  target?: string;
  verdict?: AuditVerdict;
  upstreamStatus?: number;
  reason?: string;
  durationMs?: number;
  params?: Record<string, unknown>;
  /** Ordinal of this line in the chain. */
  seq?: number;
  /** Hash of the previous line, or null at the start of a chain segment. */
  prev?: string | null;
}

/**
 * Whether the lines in the window still hash to what the next line claims.
 *
 * `intact` false means a line was altered or removed after it was written. It says nothing
 * about lines cut from the end of the log: a shorter valid chain is still valid, which is
 * why a copy shipped off the host complements this rather than duplicating it.
 */
export interface ChainStatus {
  intact: boolean;
  /** Links checked. Zero when the window holds fewer than two lines. */
  verified: number;
  /** `seq` of the first line whose `prev` did not match. */
  brokenAt?: number;
  /** Restarts seen in the window: a segment boundary, not a break. */
  segments: number;
}

export interface AuditQuery {
  since?: string;
  until?: string;
  tool?: string;
  target?: string;
  verdict?: AuditVerdict;
  risk?: RiskClass;
  /** Exact actor subject. Callers restricted to their own history get this forced. */
  subject?: string;
  includeStarted?: boolean;
  limit: number;
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  /** Lines parsed from the window, before filtering. */
  scanned: number;
  /** True when the read window did not reach the start of the file. */
  truncated: boolean;
  /** Integrity of the hash chain over the whole window, not only the filtered entries. */
  chain: ChainStatus;
}

/**
 * Bytes read from the end of the file in one query.
 *
 * The log only grows, so reading it whole would be unbounded work on a busy deployment.
 * Reading a window from the end keeps a query cheap and still answers the common question —
 * what happened recently — while `truncated` tells the caller when older entries exist
 * beyond it.
 */
export const READ_WINDOW_BYTES = 2 * 1024 * 1024;

export function queryAuditLog(
  filePath: string,
  query: AuditQuery,
  windowBytes: number = READ_WINDOW_BYTES,
): AuditQueryResult {
  const { text, partialFirstLine, moreBehind } = readTail(filePath, windowBytes);

  const lines = text.split('\n').filter((line) => line !== '');
  // A window that starts mid-file almost always begins inside a line; drop that fragment.
  const usable = partialFirstLine ? lines.slice(1) : lines;

  const entries: AuditEntry[] = [];
  let scanned = 0;

  // Newest first: walk backwards and stop as soon as the limit is met.
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const line = usable[index] as string;
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      // A truncated or hand-edited line must not fail the whole query.
      continue;
    }
    scanned += 1;
    if (matches(entry, query)) {
      entries.push(entry);
      if (entries.length >= query.limit) break;
    }
  }

  return { entries, scanned, truncated: moreBehind, chain: verifyChain(usable) };
}

/**
 * Walks the window forwards and checks each line against the hash its successor recorded.
 *
 * Verification covers every line in the window, not the filtered result: a query for one
 * domain must still notice that the log around it was edited. The first line is never
 * checkable — whatever it points at lies outside the window — so a window of one line is
 * reported as intact with nothing verified, which is the honest answer.
 */
export function verifyChain(lines: string[]): ChainStatus {
  let verified = 0;
  let segments = 0;

  for (let index = 1; index < lines.length; index += 1) {
    const raw = lines[index] as string;
    let entry: { seq?: number; prev?: string | null };
    try {
      entry = JSON.parse(raw) as { seq?: number; prev?: string | null };
    } catch {
      continue;
    }

    // A line written before chaining existed carries no `prev`; there is nothing to check
    // and nothing to accuse it of.
    if (entry.prev === undefined) continue;

    if (entry.prev === null) {
      // The process restarted here. On a stream that is expected — it cannot see what a
      // previous run wrote — so the chain resumes rather than breaks.
      segments += 1;
      continue;
    }

    if (entry.prev !== hashLine(lines[index - 1] as string)) {
      return {
        intact: false,
        verified,
        segments,
        ...(entry.seq === undefined ? {} : { brokenAt: entry.seq }),
      };
    }
    verified += 1;
  }

  return { intact: true, verified, segments };
}

function matches(entry: AuditEntry, query: AuditQuery): boolean {
  if (!query.includeStarted && entry.phase !== 'completed') return false;
  if (query.subject !== undefined && entry.actor?.subject !== query.subject) return false;
  if (query.tool !== undefined && entry.tool !== query.tool) return false;
  if (query.target !== undefined && entry.target !== query.target) return false;
  if (query.verdict !== undefined && entry.verdict !== query.verdict) return false;
  if (query.risk !== undefined && entry.risk !== query.risk) return false;
  if (query.since !== undefined && entry.ts < query.since) return false;
  if (query.until !== undefined && entry.ts > query.until) return false;
  return true;
}

/**
 * Reads at most `windowBytes` of the log, newest first, spanning the rotated generation.
 *
 * The writer rotates the file to `<file>.1` at its size ceiling. Reading only the current
 * file would make the history silently forget everything before the last rotation, and
 * report `truncated: false` while doing it — worse than an empty answer, because it looks
 * complete. So whatever budget the current file leaves is spent on the rotated one.
 */
function readTail(filePath: string, windowBytes: number): WindowRead {
  const current = readFileTail(filePath, windowBytes);
  if (!current.reachedStart) {
    return { text: current.text, partialFirstLine: true, moreBehind: true };
  }

  const remaining = windowBytes - Buffer.byteLength(current.text, 'utf8');
  const rotatedPath = `${filePath}${ROTATED_SUFFIX}`;

  // No budget left to look behind, but the whole current file is intact and starts on a
  // line boundary — so nothing to drop, even though older entries may exist.
  if (remaining <= 0) {
    return {
      text: current.text,
      partialFirstLine: false,
      moreBehind: readFileTail(rotatedPath, 0).exists,
    };
  }

  const rotated = readFileTail(rotatedPath, remaining);
  if (!rotated.exists) {
    return { text: current.text, partialFirstLine: false, moreBehind: false };
  }

  // Every line ends with a newline, so plain concatenation keeps them intact.
  return {
    text: rotated.text + current.text,
    partialFirstLine: !rotated.reachedStart,
    moreBehind: !rotated.reachedStart,
  };
}

interface WindowRead {
  text: string;
  /** The window began mid-line, so the first line is a fragment to discard. */
  partialFirstLine: boolean;
  /** Entries exist before the window. */
  moreBehind: boolean;
}

interface TailRead {
  text: string;
  /** False when the read started past the beginning of the file. */
  reachedStart: boolean;
  exists: boolean;
}

function readFileTail(filePath: string, windowBytes: number): TailRead {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    // No log file yet simply means nothing has been recorded.
    return { text: '', reachedStart: true, exists: false };
  }

  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, windowBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    return { text: buffer.toString('utf8'), reachedStart: start === 0, exists: true };
  } finally {
    closeSync(fd);
  }
}
