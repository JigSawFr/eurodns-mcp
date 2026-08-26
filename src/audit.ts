import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AuditConfig } from './config.js';
import type { RiskClass } from './constants.js';

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

  constructor(config: AuditConfig, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
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
        this.write({
          ...this.baseLine(correlationId, context),
          phase: 'completed',
          verdict: outcome.verdict,
          ...(outcome.upstreamStatus === undefined
            ? {}
            : { upstreamStatus: outcome.upstreamStatus }),
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          durationMs: this.now() - startedAt,
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

  private write(line: Record<string, unknown>): void {
    if (this.config.destination === 'none') return;
    const serialized = `${JSON.stringify(line)}\n`;

    switch (this.config.destination) {
      case 'stdout':
        // Only reachable over HTTP; the stdio transport rejects this at configuration time.
        process.stdout.write(serialized);
        return;
      case 'stderr':
        process.stderr.write(serialized);
        return;
      case 'file':
        try {
          appendFileSync(this.config.filePath as string, serialized, 'utf8');
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
        return;
    }
  }
}
