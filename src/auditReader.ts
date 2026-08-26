import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import type { RiskClass } from './constants.js';
import type { AuditVerdict } from './audit.js';

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
  const { text, truncated } = readTail(filePath, windowBytes);

  const lines = text.split('\n').filter((line) => line !== '');
  // A window that starts mid-file almost always begins inside a line; drop that fragment.
  const usable = truncated ? lines.slice(1) : lines;

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

  return { entries, scanned, truncated };
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

/** Reads at most `windowBytes` from the end of the file. */
function readTail(filePath: string, windowBytes: number): { text: string; truncated: boolean } {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    // No log file yet simply means nothing has been recorded.
    return { text: '', truncated: false };
  }

  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, windowBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    return { text: buffer.toString('utf8'), truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}
