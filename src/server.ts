import { McpServer } from '@modelcontextprotocol/server';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { AuditLogger, type AuditActor } from './audit.js';
import type { Config } from './config.js';
import { EuroDnsClient, type FetchLike } from './services/client.js';
import { registerAuditTools } from './tools/audit.js';
import { registerDnsTools } from './tools/dns.js';
import { registerGeneratedTools } from './tools/registry.js';
import type { ToolContext } from './tools/context.js';
import type { MetricsRegistry } from './metrics.js';
import { TOOL_LIST_CACHE_MS, UNKNOWN_VERSION } from './constants.js';
import { buildInstructions, hiddenClasses } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';

export const SERVER_NAME = 'eurodns-mcp-server';

/**
 * The version the server announces, taken from the package rather than repeated here.
 *
 * A second place to keep in step always drifts, and this one already had: the literal stayed
 * at `0.1.0` while the package reached 0.2.1, so the MCP handshake and
 * `eurodns_mcp_build_info` both reported a version that had not shipped for two releases.
 *
 * `rootDir: "src"` rules out a static `import '../package.json'`, hence `createRequire`. The
 * relative path holds in all three layouts because `src/` and `dist/` both sit one level
 * under the package root: running from source, from the published package, and from the
 * image, where the Dockerfile puts `package.json` in `/app` and the build in `/app/dist`.
 *
 * The same argument covers the description and repository URL the landing page shows, which
 * is why this reads a named field rather than the version alone.
 */
export function packageField(name: 'version' | 'description' | 'homepage'): string | undefined {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as Record<string, unknown>;
    const value = pkg[name];
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

export const SERVER_VERSION = packageField('version') ?? UNKNOWN_VERSION;

/**
 * Description and repository, resolved once beside the version and for the same reason.
 *
 * The fallbacks exist because `packageField` can return nothing — its `createRequire` sits in
 * a `try` — not because these fields are ever absent from this package. Keeping all three
 * resolutions together means one pattern to understand rather than three scattered `??`.
 */
export const SERVER_DESCRIPTION =
  packageField('description') ?? 'Model Context Protocol server for the EuroDNS User API.';
export const SERVER_REPOSITORY = packageField('homepage') ?? 'https://github.com/';

export interface BuildOptions {
  config: Config;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  transport: 'stdio' | 'http';
  /**
   * Process-wide counters. The HTTP transport builds a fresh server per request, so this
   * has to come from outside or every request would start counting from zero.
   */
  metrics?: MetricsRegistry;
  /**
   * Process-wide audit logger, for the same reason and a sharper one: it carries the hash
   * chain. A logger per request would open a new chain segment on every call, which on a
   * stream destination — where there is no file to resume from — means no chain at all.
   */
  audit?: AuditLogger;
}

/** Identity used when the transport carries no token of its own. */
function fallbackActor(options: BuildOptions): AuditActor {
  if (options.transport === 'stdio') {
    let username = 'unknown';
    try {
      username = userInfo().username;
    } catch {
      // Some sandboxes have no passwd entry; the audit line still records the mode.
    }
    return { mode: 'stdio', subject: username };
  }

  const { authMode, staticTokenLabel } = options.config.http;
  return authMode === 'token'
    ? { mode: 'token', subject: staticTokenLabel }
    : { mode: 'none', subject: 'anonymous' };
}

/**
 * The line each entry point writes to stderr when it comes up.
 *
 * Built here rather than in the two entry points because it is the operator's only summary
 * of what this process will and will not do — and because inside `main()` it was
 * unreachable from a test, so the hidden-class list it carries had nothing checking it.
 */
export function startupLine(options: {
  config: Config;
  toolCount: number;
  /** Absent on stdio, where there is nothing to listen on. */
  endpoint?: { url: string; authMode: string };
}): string {
  const hidden = hiddenClasses(options.config);
  const where = options.endpoint
    ? `listening on ${options.endpoint.url} (auth: ${options.endpoint.authMode}, ` +
      `${options.toolCount} tools${hidden.length ? `, hidden: ${hidden.join(', ')}` : ''})`
    : `ready on stdio with ${options.toolCount} tools` +
      `${hidden.length ? ` (hidden: ${hidden.join(', ')})` : ''}`;

  return `${SERVER_NAME} ${SERVER_VERSION} ${where}`;
}

export interface BuiltServer {
  server: McpServer;
  context: ToolContext;
  toolCount: number;
  /** Two of the four are conditional, on the same guardrails that hide tools. */
  promptCount: number;
  resourceCount: number;
}

export function buildServer(options: BuildOptions): BuiltServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      // The only documentation a model ever reads. Config-derived, so it names this
      // deployment's character limit and the classes it hides rather than the defaults.
      instructions: buildInstructions(options.config),
      // The tool surface is generated from a document vendored in the image: it is identical
      // for every caller and changes only when a new image ships. Without a hint the SDK
      // emits `ttlMs: 0`, so a stateless deployment rebuilds and serialises 80-odd tools on
      // every single request. `public` is safe precisely because nothing here is per-caller —
      // the guardrails that do vary decide which tools exist at construction, and a
      // deployment that changes them restarts the process.
      cacheHints: {
        'tools/list': { ttlMs: TOOL_LIST_CACHE_MS, cacheScope: 'public' },
        'server/discover': { ttlMs: TOOL_LIST_CACHE_MS, cacheScope: 'public' },
        // The prompt and resource lists are decided by the same guardrails at construction,
        // so the argument above applies to them unchanged.
        'prompts/list': { ttlMs: TOOL_LIST_CACHE_MS, cacheScope: 'public' },
        'resources/list': { ttlMs: TOOL_LIST_CACHE_MS, cacheScope: 'public' },
      },
    },
  );

  const context: ToolContext = {
    config: options.config,
    client: new EuroDnsClient(options.config.upstream, options.fetchImpl),
    audit: options.audit ?? new AuditLogger(options.config.audit, Date.now, options.metrics),
    fallbackActor: fallbackActor(options),
    requireScopes: options.transport === 'http' && options.config.http.authMode === 'oauth',
    sessionful: options.transport === 'stdio',
  };

  const generated = registerGeneratedTools(server, context);
  const dns = registerDnsTools(server, context);
  const audit = registerAuditTools(server, context);
  const prompts = registerPrompts(server, context);
  const resources = registerResources(server, context);

  return {
    server,
    context,
    toolCount: generated + dns + audit,
    promptCount: prompts,
    resourceCount: resources,
  };
}
