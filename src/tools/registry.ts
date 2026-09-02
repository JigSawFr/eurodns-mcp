import {
  inputRequired,
  inputResponse,
  type McpServer,
  type AuthInfo,
} from '@modelcontextprotocol/server';
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
import type { GuardrailConfig } from '../config.js';
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
  // `-1` is the API's own spelling for "everything in one page", documented on the
  // `pagination-size` header. Rejecting it made this server narrower than the API it wraps,
  // and pushed callers into paginating by hand for a result the vendor will return whole.
  // The 500 ceiling stays as a guard against a typo asking for a million.
  size: z
    .number()
    .int()
    .refine((value) => value === -1 || (value >= 1 && value <= 500), {
      message: 'size must be between 1 and 500, or -1 for every result in one page',
    })
    .optional()
    .describe('Results per page, or -1 for all results in a single page.'),
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
const outputSchema = z.object({
  status: z.number().int().describe('Upstream HTTP status code.'),
  data: z.unknown().describe('Response body as returned by the API.'),
});

/**
 * A shape being assembled.
 *
 * `ZodRawShape` is readonly from zod 4 on, so it describes a finished shape rather than one
 * under construction. Building in a mutable map and returning it as `ZodRawShape` keeps the
 * published type honest without fighting the library.
 */
type MutableShape = { -readonly [K in keyof ZodRawShape]: ZodRawShape[K] };

function parameterShape(params: GeneratedParameter[]): ZodRawShape {
  const shape: MutableShape = {};
  for (const param of params) {
    const described = param.description ? param.schema.describe(param.description) : param.schema;
    shape[toCamelCase(param.name)] = param.required ? described : described.optional();
  }
  return shape;
}

/**
 * The input schema for one operation.
 *
 * Assembled as a shape from three parameter groups, then wrapped: from the 2026-07-28 SDK a
 * tool takes a Standard Schema object rather than a raw shape.
 */
export function buildInputSchema(operation: GeneratedOperation) {
  const shape: MutableShape = {
    ...parameterShape(operation.pathParams),
    ...parameterShape(operation.queryParams),
    ...parameterShape(operation.headerParams),
  };

  if (operation.paginated) Object.assign(shape, paginationShape);

  if (operation.body) {
    const schema = operation.body.schema.describe('Request body.');
    shape.body = operation.body.required ? schema : schema.optional();
  }

  return z.object(shape);
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
 *
 * Every tool a handler gates on scopes must appear here, or the gate never runs for it and
 * the handler's own check becomes the only thing standing between a caller and an operation
 * their token does not authorise. A test asserts that, because the failure mode of
 * forgetting is silent: the tool works, for everyone.
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

/**
 * Whether a deployment advertises a tool it would run.
 *
 * A disabled risk class is hidden rather than advertised-and-refused. The refusal still
 * exists — `evaluateGuardrails` is what actually enforces it, and a tool registered by
 * another path still meets it — but a surface that lists eight destructive tools which can
 * only ever answer "this is disabled" misdescribes the deployment and spends the model's
 * attempts teaching it what the list already could have said.
 */
export function isAdvertised(risk: RiskClass, guardrails: GuardrailConfig): boolean {
  if (risk === 'read') return true;
  if (guardrails.readOnly) return false;
  if (risk === 'billing') return guardrails.allowBilling;
  if (risk === 'destructive') return guardrails.allowDestructive;
  return true;
}

/** The key the confirmation exchange is carried under, within one request's scope. */
const CONFIRM_KEY = 'confirm';

/** Whether this risk class has to be confirmed before it runs. */
function needsConfirmation(risk: RiskClass, guardrails: GuardrailConfig): boolean {
  if (guardrails.confirm === 'all') return risk === 'destructive' || risk === 'billing';
  if (guardrails.confirm === 'destructive') return risk === 'destructive';
  return false;
}

/**
 * Whether this request can carry a confirmation exchange back to the caller.
 *
 * A 2026-07-28 request carries its own envelope, and the exchange rides the request itself —
 * no session needed, so it works on the stateless HTTP transport. Anything else is 2025-era
 * traffic, where the SDK's shim has to push a real server-to-client request: that needs a
 * session, which a per-request stateless instance does not have. The SDK refuses there on its
 * own, but with an error about protocol plumbing; refusing here instead says what a
 * deployment can actually do about it.
 */
function canConfirm(context: ToolContext, envelopePresent: boolean): boolean {
  return envelopePresent || context.sessionful;
}

export function registerGeneratedTools(server: McpServer, context: ToolContext): number {
  let registered = 0;

  for (const operation of OPERATIONS) {
    if (!isAdvertised(operation.risk, context.config.guardrails)) continue;

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
      inputSchema: buildInputSchema(operation),
      outputSchema,
      annotations: {
        readOnlyHint: isRead,
        destructiveHint: operation.risk === 'destructive' || operation.method === 'DELETE',
        idempotentHint: ['GET', 'PUT', 'DELETE'].includes(operation.method),
        openWorldHint: true,
      },
    },
    async (rawArgs, ctx) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const identity = identityFrom(context, ctx?.http?.authInfo);
      const target = auditTarget(args);

      /** Records a refusal. Kept as one step so a denial is never left unlogged. */
      const deny = (reason: string) => {
        const denied = context.audit.begin({
          actor: identity.actor,
          tool: name,
          risk: operation.risk,
          target,
          params: auditParams(args),
        });
        denied.complete({ verdict: 'denied', reason });
        return errorResult(reason);
      };

      const decision = evaluateGuardrails(
        operation.risk,
        context.config.guardrails,
        identity.scopes,
      );
      if (!decision.allowed) return deny(decision.reason);

      if (needsConfirmation(operation.risk, context.config.guardrails)) {
        const answer = inputResponse(ctx?.mcpReq?.inputResponses, CONFIRM_KEY);

        if (answer.kind === 'elicit' && answer.action !== 'accept') {
          const how = answer.action === 'decline' ? 'declined' : 'cancelled';
          return deny(`Refused: the caller ${how} the confirmation.`);
        }

        // Asserted by the client, never proven to come from a person. This raises the bar on
        // accidents; it is not an authorisation check, which is why the deployment switches
        // above still run first and still decide what is possible at all.
        const confirmed =
          answer.kind === 'elicit' && (answer.content as { confirm?: unknown } | undefined)
            ? (answer.content as { confirm?: unknown }).confirm === true
            : false;

        if (!confirmed) {
          if (answer.kind === 'elicit') {
            return deny('Refused: the confirmation came back without an explicit yes.');
          }
          if (!canConfirm(context, ctx?.mcpReq?.envelope !== undefined)) {
            return deny(
              `${name} needs confirmation before it runs, and this connection cannot carry ` +
                'one: the request is 2025-era traffic on a stateless HTTP transport, which ' +
                'has no session for the exchange to travel over. Connect a client speaking ' +
                'the 2026-07-28 revision, use the stdio transport, or unset EURODNS_CONFIRM.',
            );
          }
          return inputRequired({
            inputRequests: {
              [CONFIRM_KEY]: inputRequired.elicit({
                message:
                  `Run ${name}${target ? ` on ${target}` : ''}? ` +
                  (operation.risk === 'billing'
                    ? 'This creates a charge or extends a paid term.'
                    : 'This cannot be undone.'),
                requestedSchema: {
                  type: 'object',
                  properties: {
                    confirm: {
                      type: 'boolean',
                      title: 'Confirm',
                      description: `${operation.method} ${operation.path}`,
                    },
                  },
                  required: ['confirm'],
                },
              }),
            },
          });
        }
      }

      const span = context.audit.begin({
        actor: identity.actor,
        tool: name,
        risk: operation.risk,
        target,
        params: auditParams(args),
      });

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
