import type { GuardrailConfig } from '../config.js';
import { SCOPES, type RiskClass } from '../constants.js';

/** The single scope that authorises a risk class. */
export function scopeForRisk(risk: RiskClass): string {
  return SCOPES[risk];
}

export type GuardrailDecision =
  | { allowed: true }
  | { allowed: false; kind: 'deployment'; reason: string }
  | { allowed: false; kind: 'scope'; reason: string; missingScopes: string[] };

/**
 * Decides whether a call may proceed.
 *
 * Two independent gates, both of which must pass:
 *
 * 1. Deployment gates (`EURODNS_READ_ONLY`, `EURODNS_ALLOW_BILLING`,
 *    `EURODNS_ALLOW_DESTRUCTIVE`) cap what this deployment permits at all.
 * 2. The caller's OAuth scopes decide who, within that cap, may do it.
 *
 * Keeping both means enabling OAuth never silently widens what the server can do, and an
 * operator can shut a whole risk class off without touching the identity provider.
 * `grantedScopes` is undefined when the transport carries no identity (stdio, static
 * token), in which case gate 1 is the only one that applies.
 *
 * `requiredScope` overrides the scope derived from the risk class. Most tools need the
 * scope of their risk class, but a few — reading the audit log — are gated on something
 * else entirely.
 */
export function evaluateGuardrails(
  risk: RiskClass,
  guardrails: GuardrailConfig,
  grantedScopes?: string[],
  requiredScope?: string,
): GuardrailDecision {
  if (guardrails.readOnly && risk !== 'read') {
    return {
      allowed: false,
      kind: 'deployment',
      reason:
        'This server runs in read-only mode. Unset EURODNS_READ_ONLY to allow operations ' +
        'that change state.',
    };
  }

  if (risk === 'billing' && !guardrails.allowBilling) {
    return {
      allowed: false,
      kind: 'deployment',
      reason:
        'Operations that create a charge or extend a paid term are disabled. Set ' +
        'EURODNS_ALLOW_BILLING=true to enable them.',
    };
  }

  if (risk === 'destructive' && !guardrails.allowDestructive) {
    return {
      allowed: false,
      kind: 'deployment',
      reason:
        'Irreversible operations outside DNS zone data are disabled. Set ' +
        'EURODNS_ALLOW_DESTRUCTIVE=true to enable them.',
    };
  }

  if (grantedScopes !== undefined) {
    const required = requiredScope ?? scopeForRisk(risk);
    if (!grantedScopes.includes(required)) {
      return {
        allowed: false,
        kind: 'scope',
        reason: `This action requires the "${required}" scope.`,
        missingScopes: [required],
      };
    }
  }

  return { allowed: true };
}
