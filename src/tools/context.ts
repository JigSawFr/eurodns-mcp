import type { AuditLogger, AuditActor } from '../audit.js';
import type { Config } from '../config.js';
import type { EuroDnsClient } from '../services/client.js';

/** Everything a tool handler needs, assembled once at server construction. */
export interface ToolContext {
  config: Config;
  client: EuroDnsClient;
  audit: AuditLogger;
  /** How to identify the caller when the transport carries no token. */
  fallbackActor: AuditActor;
  /**
   * Whether every call must arrive with a scoped identity.
   *
   * True under OAuth, where an unidentified caller is a failure rather than a mode of use.
   * False on stdio and behind a static token, which carry no per-user identity by design —
   * there the deployment guardrails are the only limit, and that is the intended contract.
   */
  requireScopes: boolean;
}

/** Identity and permissions for one tool call, derived from the request's auth info. */
export interface CallerIdentity {
  actor: AuditActor;
  /** Undefined when the transport carries no per-user identity to scope against. */
  scopes?: string[];
}
