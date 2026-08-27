/**
 * Prometheus-format counters for the tool surface.
 *
 * Deliberately hand-rolled and tiny. A metrics client library would be a fifth production
 * dependency for what amounts to four maps and a string template, and the exposition format
 * is stable and text-based by design.
 *
 * Everything here is fed from the audit logger, because every tool call passes through it
 * exactly once whatever its outcome — a counter placed anywhere else would have to be
 * threaded through eighty-odd handlers and would still miss the refusals.
 *
 * No label carries a domain, a subscription id or an actor. Those belong in the audit log,
 * which is access-controlled; a metrics endpoint is polled by machines that have no business
 * learning which domains a deployment manages, and per-domain labels would blow up
 * cardinality besides.
 */

import { statSync } from 'node:fs';
import type { RiskClass } from './constants.js';
import type { AuditVerdict } from './audit.js';

export interface CallObservation {
  tool: string;
  risk: RiskClass;
  verdict: AuditVerdict;
  durationMs: number;
  upstreamStatus?: number;
}

/** Context the registry cannot know on its own, supplied at render time. */
export interface RenderContext {
  version: string;
  toolCount: number;
  /** Audit log path, when the destination is a file, so its size can be reported. */
  auditFile?: string;
}

const PREFIX = 'eurodns_mcp';

/** Escapes a Prometheus label value: backslash, double quote and newline. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export class MetricsRegistry {
  private readonly startedAt: number;
  /**
   * `tool\u0000risk\u0000verdict` to count.
   *
   * NUL separates the three parts because none of them can contain it. It is written as
   * the escape rather than the byte on purpose: a raw NUL makes git, grep and `file` treat
   * the whole source file as binary, so it drops out of repository-wide searches and its
   * diffs stop being reviewable. That is exactly what had happened to this file.
   */
  private readonly calls = new Map<string, number>();
  /** Upstream HTTP status to count. */
  private readonly upstream = new Map<number, number>();
  /** Risk class to accumulated seconds, and to observation count. */
  private readonly durationSum = new Map<string, number>();
  private readonly durationCount = new Map<string, number>();
  /** Lines the collector never accepted, and lines dropped before it was tried. */
  private auditForwardFailures = 0;
  private auditForwardDropped = 0;

  constructor(now: () => number = Date.now) {
    this.startedAt = now();
  }

  recordCall(observation: CallObservation): void {
    const key = `${observation.tool}\u0000${observation.risk}\u0000${observation.verdict}`;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);

    this.durationSum.set(
      observation.risk,
      (this.durationSum.get(observation.risk) ?? 0) + observation.durationMs / 1000,
    );
    this.durationCount.set(observation.risk, (this.durationCount.get(observation.risk) ?? 0) + 1);

    if (observation.upstreamStatus !== undefined) {
      const status = observation.upstreamStatus;
      this.upstream.set(status, (this.upstream.get(status) ?? 0) + 1);
    }
  }

  recordAuditForwardFailure(): void {
    this.auditForwardFailures += 1;
  }

  recordAuditForwardDrop(): void {
    this.auditForwardDropped += 1;
  }

  render(context: RenderContext): string {
    const lines: string[] = [];

    const metric = (name: string, help: string, type: 'counter' | 'gauge') => {
      lines.push(`# HELP ${PREFIX}_${name} ${help}`, `# TYPE ${PREFIX}_${name} ${type}`);
    };

    metric('build_info', 'Server version, as a label on a constant value.', 'gauge');
    lines.push(`${PREFIX}_build_info{version="${escapeLabel(context.version)}"} 1`);

    metric('start_time_seconds', 'Unix time at which this process started.', 'gauge');
    lines.push(`${PREFIX}_start_time_seconds ${Math.floor(this.startedAt / 1000)}`);

    metric('tools_registered', 'Tools this process advertises.', 'gauge');
    lines.push(`${PREFIX}_tools_registered ${context.toolCount}`);

    metric(
      'tool_calls_total',
      'Tool calls by tool, risk class and outcome. "denied" counts guardrail and scope refusals.',
      'counter',
    );
    for (const [key, count] of [...this.calls].sort()) {
      const [tool, risk, verdict] = key.split('\u0000') as [string, string, string];
      lines.push(
        `${PREFIX}_tool_calls_total{tool="${escapeLabel(tool)}",risk="${risk}",verdict="${verdict}"} ${count}`,
      );
    }

    metric('upstream_responses_total', 'Responses from the EuroDNS API by status code.', 'counter');
    for (const [status, count] of [...this.upstream].sort((a, b) => a[0] - b[0])) {
      lines.push(`${PREFIX}_upstream_responses_total{status="${status}"} ${count}`);
    }

    metric('tool_duration_seconds', 'Total time spent in tool calls, by risk class.', 'counter');
    for (const [risk, seconds] of [...this.durationSum].sort()) {
      lines.push(`${PREFIX}_tool_duration_seconds_sum{risk="${risk}"} ${seconds.toFixed(6)}`);
      lines.push(
        `${PREFIX}_tool_duration_seconds_count{risk="${risk}"} ${this.durationCount.get(risk) ?? 0}`,
      );
    }

    // Both are zero on a deployment that ships nothing, which is the honest reading: no
    // collector configured means no lines failed to reach one. Either climbing means the
    // second copy of the log has holes in it — invisible otherwise, since the collector
    // looks the same whether it is idle or unreachable.
    metric(
      'audit_forward_failures_total',
      'Audit lines a collector never accepted, after retries.',
      'counter',
    );
    lines.push(`${PREFIX}_audit_forward_failures_total ${this.auditForwardFailures}`);

    metric(
      'audit_forward_dropped_total',
      'Audit lines dropped from a full forward queue before any send was attempted.',
      'counter',
    );
    lines.push(`${PREFIX}_audit_forward_dropped_total ${this.auditForwardDropped}`);

    // A log that stops growing is a log that stopped being written, which is worth an alert
    // of its own — and one approaching its ceiling is about to lose its older generation.
    if (context.auditFile !== undefined) {
      metric('audit_log_bytes', 'Size of the current audit log file.', 'gauge');
      lines.push(`${PREFIX}_audit_log_bytes ${sizeOf(context.auditFile)}`);
    }

    return `${lines.join('\n')}\n`;
  }
}

function sizeOf(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    // Nothing written yet, which is a legitimate zero rather than an error.
    return 0;
  }
}
