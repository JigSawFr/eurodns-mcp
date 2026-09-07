import type { AuditOutcome } from '../audit.js';
import {
  EuroDnsApiError,
  EuroDnsTransportError,
  EuroDnsUnconfiguredError,
} from '../services/errors.js';

/**
 * The audit reason for a call refused because the process holds no credentials.
 *
 * In the same register as the other short reasons (`transport`, a code list, an HTTP status)
 * so `eurodns_audit_query` can filter on it, and distinct from every guardrail reason, which
 * name the variable a caller would have to change.
 */
export const NO_CREDENTIALS_REASON = 'no credentials';

/**
 * How a thrown upstream error is recorded in the audit log.
 *
 * Written once because it used to be written twice — the generated tools and the DNS
 * workflow tools each mapped the same two error classes — and a third class would have made
 * it three copies with a fourth path (`search`/`fetch`) mapping nothing at all.
 *
 * A missing credential is a **denial**, not a failure: nothing was attempted, and the cause
 * is the deployment's configuration, which is the same category as a guardrail refusal. The
 * reason string keeps the two apart in the log.
 */
export function failureOutcome(error: unknown): AuditOutcome {
  if (error instanceof EuroDnsUnconfiguredError) {
    return { verdict: 'denied', reason: NO_CREDENTIALS_REASON };
  }
  if (error instanceof EuroDnsApiError) {
    return {
      verdict: 'failed',
      upstreamStatus: error.status,
      reason: error.codes.join(',') || `HTTP ${error.status}`,
    };
  }
  return { verdict: 'failed', reason: 'transport' };
}

/**
 * What the caller is told. The typed errors carry a message written for the model; anything
 * else gets the tool's own fallback rather than a stack trace's first line.
 */
export function failureMessage(error: unknown, fallback: string): string {
  return error instanceof EuroDnsApiError ||
    error instanceof EuroDnsTransportError ||
    error instanceof EuroDnsUnconfiguredError
    ? error.message
    : fallback;
}
