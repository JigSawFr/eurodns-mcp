import type { NextFunction, Request, Response } from 'express';
// Side-effect import: this is what brings in the SDK's `Request.auth` declaration merging,
// which is how `req.auth` below is typed at all.
import '@modelcontextprotocol/express';
import type { ToolRequirement } from '../tools/registry.js';
import { advertisedScope } from './scopes.js';

interface JsonRpcCall {
  method?: string;
  params?: { name?: string };
}

/** Collects the tool names a request would invoke, across single and batched calls. */
function calledTools(body: unknown): string[] {
  const messages: JsonRpcCall[] = Array.isArray(body) ? body : [body as JsonRpcCall];
  return messages
    .filter((message) => message?.method === 'tools/call')
    .map((message) => message.params?.name)
    .filter((name): name is string => typeof name === 'string');
}

/**
 * Refuses a call whose token lacks the scope for what it is about to do, and tells the
 * client which scope to ask for.
 *
 * The specification's step-up flow depends on this being an HTTP 403 carrying
 * `error="insufficient_scope"` and the required scope, so a client can request consent for
 * exactly what is missing instead of failing outright. That has to happen before dispatch,
 * which is why the gate reads the tool name from the JSON-RPC body rather than relying on
 * the per-tool check inside the handler — the handler check remains as a second line, and
 * is the only one that applies on stdio.
 *
 * `scopePrefix` applies to what this gate *says*, never to what it *checks*. The token was
 * issued by the authorization server and carries scopes in whatever form that server puts in
 * `scp` — bare, under Entra ID. Prefixing the membership test below would therefore reject
 * every valid token. Prefixing the two outputs is what makes the step-up flow work, because
 * the client has to hand the name back to an authorization server that may qualify it. See
 * `advertisedScope`.
 */
export function scopeGate(requirements: Map<string, ToolRequirement>, scopePrefix = '') {
  return (req: Request, res: Response, next: NextFunction): void => {
    // The gate is only mounted behind requireBearerAuth, so an absent identity here means
    // the middleware chain was reordered or bypassed. Refuse rather than wave it through:
    // a scope gate that opens when it cannot see who is calling protects nothing.
    const granted = req.auth?.scopes;
    if (!granted) {
      res.status(403).json({
        error: 'insufficient_scope',
        error_description: 'No verified identity is attached to this request.',
      });
      return;
    }

    const missing = new Set<string>();
    for (const tool of calledTools(req.body)) {
      const requirement = requirements.get(tool);
      if (!requirement) continue;
      // Deliberately the bare scope: this is the comparison, not the announcement.
      if (!granted.includes(requirement.scope)) missing.add(requirement.scope);
    }

    if (missing.size === 0) {
      next();
      return;
    }

    const scopes = [...missing].map((scope) => advertisedScope(scopePrefix, scope)).join(' ');
    res.set(
      'WWW-Authenticate',
      `Bearer error="insufficient_scope", error_description="Additional scope required", scope="${scopes}"`,
    );
    res.status(403).json({
      error: 'insufficient_scope',
      error_description: `This request requires the following scope: ${scopes}`,
    });
  };
}
