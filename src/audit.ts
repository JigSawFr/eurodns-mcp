import {
  appendFileSync,
  chmodSync,
  closeSync,
  openSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { AuditConfig } from './config.js';
import { AUDIT_FILE_MODE, ROTATED_SUFFIX, type RiskClass } from './constants.js';
import type { MetricsRegistry } from './metrics.js';

export { AUDIT_FILE_MODE, ROTATED_SUFFIX };

/** Bytes read from the end of the log to recover where the hash chain left off. */
const TAIL_PROBE_BYTES = 64 * 1024;

/** SHA-256 of a line exactly as it was written, without the trailing newline. */
export function hashLine(serialized: string): string {
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Reads the last complete line of a file, or undefined when there is none.
 *
 * Only the tail is read: the log grows without bound between rotations, and this runs once
 * at startup to find where the chain stopped. A line longer than the probe window would be
 * missed, which redacted audit lines — scalars only — never approach.
 */
function readLastLine(filePath: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return undefined;
  }

  try {
    const size = statSync(filePath).size;
    if (size === 0) return undefined;

    const length = Math.min(size, TAIL_PROBE_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);

    // Every write ends with a newline, so the final element is empty and the one before it
    // is a complete line even when the window opened mid-file.
    const lines = buffer
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '');
    return lines.at(-1);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Who performed an action. The upstream API sees a single shared API key for every
 * caller, so this log is the only place an individual action can be attributed.
 */
export interface AuditActor {
  /** Which authentication path identified this caller. */
  mode: 'oauth' | 'token' | 'stdio' | 'none';
  /** Identity claim, static-token label, or OS user, depending on the mode. */
  subject: string;
  /** OAuth client the token was issued to, when known. */
  clientId?: string;
}

export interface AuditContext {
  actor: AuditActor;
  tool: string;
  risk: RiskClass;
  /** Domain, subscription id, or other primary object the call acts on. */
  target?: string;
  /** Already reduced to a whitelist of scalar values by the caller. */
  params?: Record<string, unknown>;
}

export type AuditVerdict = 'allowed' | 'denied' | 'failed';

export interface AuditOutcome {
  verdict: AuditVerdict;
  /** HTTP status returned by the upstream API, when a call was made. */
  upstreamStatus?: number;
  /** Why a call was refused, or how it failed. Never contains payload data. */
  reason?: string;
}

/** A call in flight. Always finish it with `complete`. */
export interface AuditSpan {
  correlationId: string;
  complete(outcome: AuditOutcome): void;
}

export class AuditLogger {
  private readonly config: AuditConfig;
  private readonly now: () => number;
  private readonly metrics: MetricsRegistry | undefined;
  /** Bytes in the current log file. Read from disk once, then tracked. */
  private fileBytes: number | undefined;
  /** Hash of the last line written, which the next line records as its `prev`. */
  private prevHash: string | null | undefined;
  private seq: number | undefined;

  constructor(config: AuditConfig, now: () => number = Date.now, metrics?: MetricsRegistry) {
    this.config = config;
    this.now = now;
    this.metrics = metrics;
  }

  /**
   * Opens a span for one tool call.
   *
   * For anything that mutates state, a `started` line is written before the upstream call
   * so that a crash mid-write still leaves a trace of what was attempted. Reads are
   * recorded once, on completion.
   */
  begin(context: AuditContext): AuditSpan {
    const correlationId = randomUUID();
    const startedAt = this.now();

    if (context.risk !== 'read') {
      this.write({ ...this.baseLine(correlationId, context), phase: 'started' });
    }

    let settled = false;
    return {
      correlationId,
      complete: (outcome: AuditOutcome) => {
        if (settled) return;
        settled = true;
        const durationMs = this.now() - startedAt;
        this.write({
          ...this.baseLine(correlationId, context),
          phase: 'completed',
          verdict: outcome.verdict,
          ...(outcome.upstreamStatus === undefined
            ? {}
            : { upstreamStatus: outcome.upstreamStatus }),
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          durationMs,
        });
        // Every call passes through here, whatever its outcome, which is what makes this
        // the one place metrics can be collected without threading a counter through the
        // tool handlers.
        this.metrics?.recordCall({
          tool: context.tool,
          risk: context.risk,
          verdict: outcome.verdict,
          durationMs,
          ...(outcome.upstreamStatus === undefined
            ? {}
            : { upstreamStatus: outcome.upstreamStatus }),
        });
      },
    };
  }

  private baseLine(correlationId: string, context: AuditContext): Record<string, unknown> {
    return {
      ts: new Date(this.now()).toISOString(),
      correlationId,
      actor: context.actor,
      tool: context.tool,
      risk: context.risk,
      ...(context.target === undefined ? {} : { target: context.target }),
      ...(context.params === undefined ? {} : { params: context.params }),
    };
  }

  /**
   * Writes one line, chained to the one before it.
   *
   * Each line carries `prev`, the SHA-256 of the previous line exactly as it was written,
   * and `seq`, its ordinal. Editing or removing a line in the middle of the log breaks the
   * chain at the next line, so tampering stops being silent — which is what a log has to
   * offer if it is to be the record of who changed DNS.
   *
   * What this does not detect is the log being cut short at the end: a shorter valid chain
   * is still a valid chain. Shipping the lines off the host as they are written is the
   * answer to that, and the two measures are complementary rather than alternatives.
   */
  private write(line: Record<string, unknown>): void {
    if (this.config.destination === 'none') return;

    if (this.prevHash === undefined) this.resumeChain();

    const serialized = `${JSON.stringify({
      ...line,
      seq: (this.seq as number) + 1,
      prev: this.prevHash,
    })}\n`;

    switch (this.config.destination) {
      case 'stdout':
        // Only reachable over HTTP; the stdio transport rejects this at configuration time.
        process.stdout.write(serialized);
        break;
      case 'stderr':
        process.stderr.write(serialized);
        break;
      case 'file':
        try {
          this.appendToFile(this.config.filePath as string, serialized);
        } catch (cause) {
          // An unwritable audit file must not take the server down, but it must be visible.
          process.stderr.write(
            `${JSON.stringify({
              ts: new Date(this.now()).toISOString(),
              level: 'error',
              message: 'audit log write failed',
              detail: cause instanceof Error ? cause.message : String(cause),
            })}\n`,
          );
        }
        break;
    }

    this.prevHash = hashLine(serialized.slice(0, -1));
    this.seq = (this.seq as number) + 1;
  }

  /**
   * Picks the chain back up where the last run left it.
   *
   * Only a file can be resumed. On a stream the process has no way to see what it wrote
   * before, so each start begins a new segment marked by `prev: null` — a verifier reads
   * that as "a restart happened here", not as a break.
   */
  private resumeChain(): void {
    this.prevHash = null;
    this.seq = 0;

    if (this.config.destination !== 'file') return;

    const last = readLastLine(this.config.filePath as string);
    if (last === undefined) return;

    try {
      const parsed = JSON.parse(last) as { seq?: unknown };
      if (typeof parsed.seq === 'number') this.seq = parsed.seq;
    } catch {
      // A corrupt final line cannot anchor the chain. Start a fresh segment rather than
      // chaining onto something unparseable — the break stays visible either way.
      return;
    }
    this.prevHash = hashLine(last);
  }

  /**
   * Appends one line, rotating first when the file has reached its ceiling.
   *
   * The size is tracked in memory and read from disk only once, so the common path costs no
   * extra syscall. Rotation replaces any previous `.1`, bounding the log at twice the
   * configured size; the history query reads across both generations.
   */
  private appendToFile(filePath: string, serialized: string): void {
    const bytes = Buffer.byteLength(serialized, 'utf8');

    if (this.fileBytes === undefined) {
      this.fileBytes = this.adoptExistingFile(filePath);
    }

    const { maxBytes } = this.config;
    if (maxBytes > 0 && this.fileBytes > 0 && this.fileBytes + bytes > maxBytes) {
      renameSync(filePath, `${filePath}${ROTATED_SUFFIX}`);
      this.fileBytes = 0;
    }

    appendFileSync(filePath, serialized, { encoding: 'utf8', mode: AUDIT_FILE_MODE });
    this.fileBytes += bytes;
  }

  /**
   * Reads the size of an existing log, and tightens its permissions if a previous run left
   * them wider. A file owned by another account cannot be chmod'ed, and that must not stop
   * the server from recording — the write itself is what matters.
   */
  private adoptExistingFile(filePath: string): number {
    let size = 0;
    try {
      const stats = statSync(filePath);
      size = stats.size;
      if ((stats.mode & 0o777) !== AUDIT_FILE_MODE) chmodSync(filePath, AUDIT_FILE_MODE);
    } catch {
      // No file yet, or permissions that cannot be changed from here.
    }
    return size;
  }
}
