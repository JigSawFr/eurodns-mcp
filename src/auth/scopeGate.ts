import type { NextFunction, Request, Response } from 'express';
// Brings in the SDK's `Request.auth` declaration merging.
import type {} from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { ToolRequirement } from '../tools/registry.js';

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
 */
export function scopeGate(requirements: Map<string, ToolRequirement>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const granted = req.auth?.scopes;
    if (!granted) {
      next();
      return;
    }

    const missing = new Set<string>();
    for (const tool of calledTools(req.body)) {
      const requirement = requirements.get(tool);
      if (!requirement) continue;
      if (!granted.includes(requirement.scope)) missing.add(requirement.scope);
    }

    if (missing.size === 0) {
      next();
      return;
    }

    const scopes = [...missing].join(' ');
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
