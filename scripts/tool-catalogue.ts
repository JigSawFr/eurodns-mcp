/**
 * Writes the tool surface as a registry sees it, for the reference TDQS linter to read.
 *
 * Boots the server twice in memory — as a default deployment, which is what Glama and every
 * other registry lists, and with every risk class and opt-in on — and writes each `tools/list`
 * to `<out>/<deployment>.json` in the shape `tdqs lint --file` accepts. The scoring itself is
 * not here: it is the `mcp-tdqs` package, Glama's reference implementation, run by
 * `npm run tdqs` and by the tool-quality workflow.
 *
 * Why a file rather than `tdqs lint --command`: the CLI spawns a server with the SDK's default
 * environment, not the caller's, so the everything deployment cannot be reached that way
 * without an `env … node dist/index.js` wrapper and a build. The in-memory transport needs
 * neither, and the two files are also the artifact a reviewer compares across commits — what a
 * model actually reads, which shows a change to the surface more plainly than the source diff.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

/** Placeholders, never credentials: `tools/list` needs none, and nothing here calls upstream. */
const BASE_ENV = {
  EURODNS_APP_ID: 'test-app-id',
  EURODNS_API_KEY: 'test-api-key',
  EURODNS_AUDIT_DESTINATION: 'none',
};

const DEPLOYMENTS: Record<string, Record<string, string>> = {
  default: {},
  everything: {
    EURODNS_ALLOW_BILLING: 'true',
    EURODNS_ALLOW_DESTRUCTIVE: 'true',
    EURODNS_COMPAT_TOOLS: 'true',
  },
};

async function listTools(overrides: Record<string, string>): Promise<unknown[]> {
  const config = loadConfig({ ...BASE_ENV, ...overrides } as NodeJS.ProcessEnv, 'stdio');
  const { server } = buildServer({ config, transport: 'stdio' });
  const client = new Client({ name: 'tool-catalogue', version: '0.0.0' }, {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
    await server.close();
  }
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  if (outDir === undefined) {
    throw new Error('usage: tsx scripts/tool-catalogue.ts --out <dir>');
  }
  mkdirSync(outDir, { recursive: true });

  for (const [deployment, overrides] of Object.entries(DEPLOYMENTS)) {
    const tools = await listTools(overrides);
    const path = join(outDir, `${deployment}.json`);
    writeFileSync(path, `${JSON.stringify({ tools }, null, 2)}\n`);
    console.error(`${deployment}: ${tools.length} tools → ${path}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
