#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config.js';
import { OnePasswordError, resolveEnvSecrets } from './secrets/index.js';
import { SERVER_NAME, SERVER_VERSION, buildServer } from './server.js';

/**
 * stdio entry point.
 *
 * The protocol defines no authorization for stdio: the client spawns this process, so the
 * trust boundary is the operating-system account, which is what audit lines record.
 * Nothing may be written to stdout except the JSON-RPC stream.
 */
async function main(): Promise<void> {
  const config = loadConfig(await resolveEnvSecrets(process.env), 'stdio');
  const { server, toolCount } = buildServer({ config, transport: 'stdio' });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio with ${toolCount} tools\n`);
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
