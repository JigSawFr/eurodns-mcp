import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z, type ZodRawShape } from 'zod';
import {
  OPERATIONS,
  type GeneratedOperation,
  type GeneratedParameter,
} from '../generated/operations.js';
import { evaluateGuardrails, scopeForRisk } from '../auth/scopes.js';
import { EuroDnsApiError, EuroDnsTransportError } from '../services/errors.js';
import { formatJson, redactForAudit } from '../services/format.js';
import { toolNameFor } from './naming.js';
import { describeOperation } from './overrides.js';
import type { CallerIdentity, ToolContext } from './context.js';
import { AUDIT_SCOPE, type RiskClass } from '../constants.js';
import { AUDIT_QUERY_TOOL_NAME } from './auditNames.js';

/** `domain-name` -> `domainName`, so tool arguments read like ordinary parameters. */
export function toCamelCase(value: string): string {
  return value.replace(/[-_](.)/g, (_, c: string) => c.toUpperCase());
}

/** Argument names whose value identifies the object an audit line is about. */
const TARGET_ARGUMENT_NAMES = ['domainName', 'subscriptionId', 'id', 'certificateId'];

const paginationShape: ZodRawShape = {
  page: z.number().int().min(1).optional().describe('1-based page number.'),
  size: z.number().int().min(1).max(500).optional().describe('Results per page.'),
  sortField: z.string().optional().describe('Field to sort by.'),
  sortOrder: z.enum(['ASC', 'DESC']).optional().describe('Sort direction.'),
};

/**
 * A permissive output schema.
 *
 * The API is known to deviate from its own document in places, so pinning
 * `structuredContent` to the generated response schema would turn a vendor-side surprise
 * into a hard tool failure. Wrapping instead gives callers reliable structured access to
 * the status and payload without asserting the payload's shape.
 */
const outputShape = {
  status: z.number().int().describe('Upstream HTTP status code.'),
  data: z.unknown().describe('Response body as returned by the API.'),
} satisfies ZodRawShape;

function parameterShape(params: GeneratedParameter[]): ZodRawShape {
  const shape: ZodRawShape = {};
  for (const param of params) {
    const described = param.description ? param.schema.describe(param.description) : param.schema;
    shape[toCamelCase(param.name)] = param.required ? described : described.optional();
  }
  return shape;
}

export function buildInputShape(operation: GeneratedOperation): ZodRawShape {
  const shape: ZodRawShape = {
    ...parameterShape(operation.pathParams),
    ...parameterShape(operation.queryParams),
    ...parameterShape(operation.headerParams),
  };

  if (operation.paginated) Object.assign(shape, paginationShape);

  if (operation.body) {
    const schema = operation.body.schema.describe('Request body.');
    shape.body = operation.body.required ? schema : schema.optional();
  }

  return shape;
}

/** Substitutes `{placeholders}` in the operation path from the call arguments. */
function resolvePath(operation: GeneratedOperation, args: Record<string, unknown>): string {
  let path = operation.path;
  for (const param of operation.pathParams) {
    const value = args[toCamelCase(param.name)];
    path = path.replace(`{${param.name}}`, encodeURIComponent(String(value ?? '')));
  }
  return path;
}

function collect(
  params: GeneratedParameter[],
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const param of params) {
    const value = args[toCamelCase(param.name)];
    if (value !== undefined) out[param.name] = value;
  }
  return out;
}

function auditTarget(args: Record<string, unknown>): string | undefined {
  for (const name of TARGET_ARGUMENT_NAMES) {
    const value = args[name];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return undefined;
}

/** Reduces call arguments to scalars safe to record. Body contents are never logged. */
function auditParams(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'body') continue;
    out[key] = redactForAudit(value);
  }
  return out;
}

/** Turns the request's auth info into an actor and, where present, a scope list. */
export function identityFrom(context: ToolContext, authInfo?: AuthInfo): CallerIdentity {
  if (!authInfo) {
    // Undefined scopes mean "this transport carries no identity to check against", which is
    // the contract on stdio and behind a static token. Under OAuth it would mean the reverse
    // — an identity that should exist and does not — so grant nothing instead of everything.
    return context.requireScopes
      ? { actor: context.fallbackActor, scopes: [] }
      : { actor: context.fallbackActor };
  }

  const extra = (authInfo.extra ?? {}) as Record<string, unknown>;
  const subject = typeof extra.subject === 'string' ? extra.subject : authInfo.clientId;
  const mode = extra.mode === 'token' ? 'token' : 'oauth';

  return {
    actor: { mode, subject, clientId: authInfo.clientId },
    // A static token carries no per-user identity, so it is not scope-checked.
    scopes: mode === 'oauth' ? authInfo.scopes : undefined,
  };
}

/** What a tool costs and what authorises it. */
export interface ToolRequirement {
  risk: RiskClass;
  scope: string;
}

/**
 * Requirements of the hand-written tools, which have no generated operation to derive from.
 *
 * Most tools need the scope of their risk class, so only the exceptions carry an explicit
 * scope: reading the audit log is a read, but of who did what rather than of EuroDNS data.
 */
export const HAND_WRITTEN_TOOL_REQUIREMENTS: Record<string, ToolRequirement> = {
  eurodns_dns_upsert_record: { risk: 'write', scope: scopeForRisk('write') },
  eurodns_dns_delete_record: { risk: 'write', scope: scopeForRisk('write') },
  eurodns_dns_diff_zone: { risk: 'read', scope: scopeForRisk('read') },
  [AUDIT_QUERY_TOOL_NAME]: { risk: 'read', scope: AUDIT_SCOPE },
};

/**
 * Tool name to its requirement, for callers that must decide before dispatch — the HTTP
 * scope gate needs to know what a call requires before the tool handler ever runs.
 */
export function toolScopeIndex(): Map<string, ToolRequirement> {
  const index = new Map<string, ToolRequirement>();
  for (const operation of OPERATIONS) {
    index.set(toolNameFor(operation), {
      risk: operation.risk,
      scope: scopeForRisk(operation.risk),
    });
  }
  for (const [name, requirement] of Object.entries(HAND_WRITTEN_TOOL_REQUIREMENTS)) {
    index.set(name, requirement);
  }
  return index;
}

function errorResult(message: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

export function registerGeneratedTools(server: McpServer, context: ToolContext): number {
  let registered = 0;

  for (const operation of OPERATIONS) {
    // Read-only deployments do not advertise tools they would refuse to run.
    if (context.config.guardrails.readOnly && operation.risk !== 'read') continue;

    registerOperation(server, context, operation);
    registered += 1;
  }

  return registered;
}

function registerOperation(
  server: McpServer,
  context: ToolContext,
  operation: GeneratedOperation,
): void {
  const name = toolNameFor(operation);
  const isRead = operation.risk === 'read';

  server.registerTool(
    name,
    {
      title: operation.summary || operation.operationId,
      description: describeOperation(operation),
      inputSchema: buildInputShape(operation),
      outputSchema: outputShape,
      annotations: {
        readOnlyHint: isRead,
        destructiveHint: operation.risk === 'destructive' || operation.method === 'DELETE',
        idempotentHint: ['GET', 'PUT', 'DELETE'].includes(operation.method),
        openWorldHint: true,
      },
    },
    async (rawArgs, extra) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const identity = identityFrom(context, extra?.authInfo);

      const span = context.audit.begin({
        actor: identity.actor,
        tool: name,
        risk: operation.risk,
        target: auditTarget(args),
        params: auditParams(args),
      });

      const decision = evaluateGuardrails(
        operation.risk,
        context.config.guardrails,
        identity.scopes,
      );
      if (!decision.allowed) {
        span.complete({ verdict: 'denied', reason: decision.reason });
        return errorResult(decision.reason);
      }

      try {
        const response = await context.client.request({
          method: operation.method,
          path: resolvePath(operation, args),
          query: collect(operation.queryParams, args),
          headers: collect(operation.headerParams, args) as Record<string, string>,
          ...(operation.body && args.body !== undefined ? { body: args.body } : {}),
          ...(operation.paginated
            ? {
                pagination: {
                  page: args.page as number | undefined,
                  size: args.size as number | undefined,
                  sortField: args.sortField as string | undefined,
                  sortOrder: args.sortOrder as string | undefined,
                },
              }
            : {}),
        });

        span.complete({ verdict: 'allowed', upstreamStatus: response.status });

        const structured = { status: response.status, data: response.data };
        const rendered = formatJson(structured, context.config.upstream.characterLimit);
        return {
          content: [{ type: 'text' as const, text: rendered.text }],
          structuredContent: structured,
        };
      } catch (error) {
        const status = error instanceof EuroDnsApiError ? error.status : undefined;
        const message =
          error instanceof EuroDnsApiError || error instanceof EuroDnsTransportError
            ? error.message
            : `Unexpected failure calling ${operation.operationId}.`;
        span.complete({
          verdict: 'failed',
          ...(status === undefined ? {} : { upstreamStatus: status }),
          reason:
            error instanceof EuroDnsApiError
              ? error.codes.join(',') || `HTTP ${status}`
              : 'transport',
        });
        return errorResult(message);
      }
    },
  );
}
