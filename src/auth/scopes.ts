import type { GuardrailConfig } from '../config.js';
import { SCOPES, type RiskClass } from '../constants.js';

/** The single scope that authorises a risk class. */
export function scopeForRisk(risk: RiskClass): string {
  return SCOPES[risk];
}

/**
 * The form a scope takes when this server *names* it to a client — never the form it
 * compares a token against.
 *
 * The asymmetry is not an oversight. An authorization server may require a qualified scope
 * in the authorization request while issuing a token that carries the bare name: Microsoft
 * Entra ID wants `api://<app-id>/eurodns.read` in the request and puts `eurodns.read` in the
 * token's `scp`. So the prefix belongs on what we advertise and on what we tell a client to
 * go and ask for — and nowhere near the membership test that reads the token.
 *
 * With no prefix configured this is the identity function, which is the whole of the
 * behaviour for an authorization server that takes scopes as named.
 */
export function advertisedScope(prefix: string, scope: string): string {
  return prefix === '' ? scope : `${prefix}${scope}`;
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
