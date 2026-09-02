import type { AuditLogger, AuditActor } from '../audit.js';
import type { Config } from '../config.js';
import type { EuroDnsClient } from '../services/client.js';
import type { PortfolioCache } from '../services/portfolio.js';

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
  /**
   * Whether the connection can carry a confirmation exchange back to the caller.
   *
   * `inputRequired` is written once and the SDK serves both protocol eras from it — but its
   * legacy shim needs a session to push the server-to-client leg through, and a stateless
   * HTTP instance never saw an `initialize`, so the SDK's gate refuses there. On a 2026-07-28
   * request the exchange rides the request itself and needs no session, which is why this is
   * a floor rather than the whole test: see `canConfirm` in the registry.
   */
  sessionful: boolean;
  /**
   * The account's domain names, held for completion.
   *
   * Process-wide rather than per-server, for the reason `metrics` and `audit` are: the HTTP
   * transport builds a fresh server per request, so a cache owned by one would never live
   * long enough to be a cache.
   */
  portfolio: PortfolioCache;
}

/** Identity and permissions for one tool call, derived from the request's auth info. */
export interface CallerIdentity {
  actor: AuditActor;
  /** Undefined when the transport carries no per-user identity to scope against. */
  scopes?: string[];
}
