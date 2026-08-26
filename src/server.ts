import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { userInfo } from 'node:os';
import { AuditLogger, type AuditActor } from './audit.js';
import type { Config } from './config.js';
import { EuroDnsClient, type FetchLike } from './services/client.js';
import { registerAuditTools } from './tools/audit.js';
import { registerDnsTools } from './tools/dns.js';
import { registerGeneratedTools } from './tools/registry.js';
import type { ToolContext } from './tools/context.js';
import type { MetricsRegistry } from './metrics.js';

export const SERVER_NAME = 'eurodns-mcp-server';
export const SERVER_VERSION = '0.1.0';

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

export interface BuiltServer {
  server: McpServer;
  context: ToolContext;
  toolCount: number;
}

export function buildServer(options: BuildOptions): BuiltServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const context: ToolContext = {
    config: options.config,
    client: new EuroDnsClient(options.config.upstream, options.fetchImpl),
    audit: options.audit ?? new AuditLogger(options.config.audit, Date.now, options.metrics),
    fallbackActor: fallbackActor(options),
    requireScopes: options.transport === 'http' && options.config.http.authMode === 'oauth',
  };

  const generated = registerGeneratedTools(server, context);
  const dns = registerDnsTools(server, context);
  const audit = registerAuditTools(server, context);

  return { server, context, toolCount: generated + dns + audit };
}
