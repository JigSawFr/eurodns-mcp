import {
  inputRequired,
  inputResponse,
  type McpServer,
  type AuthInfo,
  type ServerContext,
} from '@modelcontextprotocol/server';
import {
  OPERATIONS,
  type GeneratedOperation,
  type GeneratedParameter,
} from '../generated/operations.js';
import { evaluateGuardrails, scopeForRisk } from '../auth/scopes.js';
import { formatJson, redactForAudit } from '../services/format.js';
import { failureMessage, failureOutcome } from './failure.js';
import { toolNameFor } from './naming.js';
import { describeOperation, titleFor } from './overrides.js';
import {
  ABSORBED_OPERATION_IDS,
  COMPOSITES,
  memberOperation,
  type CompositeTool,
} from './composites.js';
import { buildInputSchema, outputSchema, toCamelCase } from './shapes.js';
import type { CallerIdentity, ToolContext } from './context.js';
import type { GuardrailConfig } from '../config.js';
import { AUDIT_SCOPE, type RiskClass } from '../constants.js';
import { AUDIT_QUERY_TOOL_NAME } from './auditNames.js';
import { PORTFOLIO_REFRESH_TOOL_NAME } from './portfolioNames.js';
import { COMPAT_FETCH_TOOL_NAME, COMPAT_SEARCH_TOOL_NAME } from './compatNames.js';

/** Argument names whose value identifies the object an audit line is about. */
const TARGET_ARGUMENT_NAMES = ['domainName', 'subscriptionId', 'id', 'certificateId'];

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
  [PORTFOLIO_REFRESH_TOOL_NAME]: { risk: 'read', scope: scopeForRisk('read') },
  // Listed whether or not `EURODNS_COMPAT_TOOLS` registers them. An entry for a tool that
  // does not exist costs nothing — the call fails as unknown either way — where a missing
  // entry would let the HTTP gate wave the call through on the one deployment that does.
  [COMPAT_SEARCH_TOOL_NAME]: { risk: 'read', scope: scopeForRisk('read') },
  [COMPAT_FETCH_TOOL_NAME]: { risk: 'read', scope: scopeForRisk('read') },
};

/**
 * Tool name to its requirement, for callers that must decide before dispatch — the HTTP
 * scope gate needs to know what a call requires before the tool handler ever runs.
 *
 * Every tool a handler gates on scopes must appear here, or the gate never runs for it and
 * the handler's own check becomes the only thing standing between a caller and an operation
 * their token does not authorise. A test asserts that, because the failure mode of
 * forgetting is silent: the tool works, for everyone.
 *
 * Absorbed operations are left out on purpose: they have no tool, so an entry for them would
 * describe a name nothing can call.
 */
export function toolScopeIndex(): Map<string, ToolRequirement> {
  const index = new Map<string, ToolRequirement>();
  for (const operation of OPERATIONS) {
    if (ABSORBED_OPERATION_IDS.has(operation.operationId)) continue;
    index.set(toolNameFor(operation), {
      risk: operation.risk,
      scope: scopeForRisk(operation.risk),
    });
  }
  for (const composite of COMPOSITES) {
    index.set(composite.name, { risk: composite.risk, scope: scopeForRisk(composite.risk) });
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

/**
 * Registers the generated operations that stand on their own as tools.
 *
 * Operations a composite absorbs are skipped: they are still called, through the
 * composite's routing, but a second registration under their own name would be the twin
 * the composites exist to remove.
 */
export function registerGeneratedTools(server: McpServer, context: ToolContext): number {
  let registered = 0;

  for (const operation of OPERATIONS) {
    if (ABSORBED_OPERATION_IDS.has(operation.operationId)) continue;
    if (!isAdvertised(operation.risk, context.config.guardrails)) continue;

    registerOperation(server, context, operation);
    registered += 1;
  }

  return registered;
}

/** Registers the tools that stand in for two operations each. See `composites.ts`. */
export function registerCompositeTools(server: McpServer, context: ToolContext): number {
  let registered = 0;

  for (const composite of COMPOSITES) {
    if (!isAdvertised(composite.risk, context.config.guardrails)) continue;

    registerComposite(server, context, composite);
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
  server.registerTool(
    name,
    {
      title: titleFor(operation),
      description: describeOperation(operation),
      inputSchema: buildInputSchema(operation),
      outputSchema,
      annotations: {
        readOnlyHint: operation.risk === 'read',
        destructiveHint: operation.risk === 'destructive' || operation.method === 'DELETE',
        idempotentHint: ['GET', 'PUT', 'DELETE'].includes(operation.method),
        openWorldHint: true,
      },
    },
    (rawArgs, ctx) =>
      executeOperation(context, operation, name, (rawArgs ?? {}) as Record<string, unknown>, ctx),
  );
}

function registerComposite(
  server: McpServer,
  context: ToolContext,
  composite: CompositeTool,
): void {
  server.registerTool(
    composite.name,
    {
      title: composite.title,
      description: composite.description,
      inputSchema: composite.inputSchema,
      outputSchema,
      annotations: composite.annotations,
    },
    (rawArgs, ctx) => {
      const route = composite.route((rawArgs ?? {}) as Record<string, unknown>);
      // The audit line carries the composite's name: that is what was called. Which member
      // it resolved to is recoverable from the recorded arguments.
      return executeOperation(
        context,
        memberOperation(route.operationId),
        composite.name,
        route.args,
        ctx,
      );
    },
  );
}

/**
 * Runs one generated operation as a tool call: guardrails, confirmation, audit, the upstream
 * request and the rendering of its answer.
 *
 * Shared between a tool that *is* an operation and a composite that has just chosen one, so
 * that the two paths cannot drift — a refusal, a confirmation prompt or an audit line looks
 * the same whichever way the operation was reached. `toolName` is the name the caller used,
 * which for a composite is not the operation's own.
 */
export async function executeOperation(
  context: ToolContext,
  operation: GeneratedOperation,
  toolName: string,
  args: Record<string, unknown>,
  ctx: ServerContext | undefined,
) {
  const identity = identityFrom(context, ctx?.http?.authInfo);
  const target = auditTarget(args);

  /** Records a refusal. Kept as one step so a denial is never left unlogged. */
  const deny = (reason: string) => {
    const denied = context.audit.begin({
      actor: identity.actor,
      tool: toolName,
      risk: operation.risk,
      target,
      params: auditParams(args),
    });
    denied.complete({ verdict: 'denied', reason });
    return errorResult(reason);
  };

  const decision = evaluateGuardrails(operation.risk, context.config.guardrails, identity.scopes);
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
          `${toolName} needs confirmation before it runs, and this connection cannot carry ` +
            'one: the request is 2025-era traffic on a stateless HTTP transport, which ' +
            'has no session for the exchange to travel over. Connect a client speaking ' +
            'the 2026-07-28 revision, use the stdio transport, or unset EURODNS_CONFIRM.',
        );
      }
      return inputRequired({
        inputRequests: {
          [CONFIRM_KEY]: inputRequired.elicit({
            message:
              `Run ${toolName}${target ? ` on ${target}` : ''}? ` +
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
    tool: toolName,
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
    span.complete(failureOutcome(error));
    return errorResult(
      failureMessage(error, `Unexpected failure calling ${operation.operationId}.`),
    );
  }
}
