#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config.js';
import { OnePasswordError, resolveEnvSecrets } from './secrets/index.js';
import { buildServer, startupLine } from './server.js';
import { AuditLogger } from './audit.js';
import { installShutdown } from './shutdown.js';

/**
 * stdio entry point.
 *
 * The protocol defines no authorization for stdio: the client spawns this process, so the
 * trust boundary is the operating-system account, which is what audit lines record.
 * Nothing may be written to stdout except the JSON-RPC stream.
 */
async function main(): Promise<void> {
  const config = loadConfig(await resolveEnvSecrets(process.env), 'stdio');

  // One logger for the process, as on HTTP: it carries the audit log's hash chain, and a
  // logger rebuilt alongside the server would start a fresh chain segment.
  const audit = new AuditLogger(config.audit);
  const { toolCount } = buildServer({ config, transport: 'stdio', audit });

  // serveStdio owns the era decision for the connection: the opening exchange selects
  // 2026-07-28 or 2025, one instance is pinned for its lifetime, and the same factory
  // serves both. Nothing here has to know which era the client speaks.
  serveStdio(() => buildServer({ config, transport: 'stdio', audit }).server);

  // The parent decides when this process ends, and on stdio that is usually a signal. If a
  // collector is configured, whatever it has not received yet would be lost without this.
  installShutdown({ drain: () => audit.close() });

  process.stderr.write(`${startupLine({ config, toolCount })}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof OnePasswordError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
