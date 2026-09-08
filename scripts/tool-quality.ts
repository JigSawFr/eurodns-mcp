/**
 * Scores the tool surface the way the registries that list this server do, without a model.
 *
 * Boots the server twice in memory — as a default deployment, which is what Glama and every
 * other registry sees, and with every risk class and opt-in on — lists the tools, and applies
 * the deterministic part of TDQS from `./tdqs/signals.ts`: the contextual signals, the hard
 * gates, the tool-count anchor and the shadowing candidates. The gates fail the run; the rest
 * is a report, on stdout and — under GitHub Actions — in the job summary.
 *
 * `--out <dir>` also writes `tool-catalogue.json`, the raw `tools/list` of both deployments.
 * That file is what a model actually reads, and a reviewer comparing two of them sees a
 * change to the surface more plainly than in any diff of the source that produced it.
 *
 * Deliberately no model call. The dimension scores Glama publishes come from one, and a
 * re-implementation here would need a key, cost money on every push, and give a different
 * number to the same text on two runs. The linter in `tests/descriptions.test.ts` is what
 * holds the prose to the rubric's shape; this measures what can be measured exactly.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import {
  contextualSignals,
  gates,
  shadowingCandidates,
  toolCountTier,
  type ContextualSignals,
  type GateFailure,
  type ShadowingCandidate,
  type ToolDefinition,
} from './tdqs/signals.js';

const PREFIX = 'eurodns_';

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

async function listTools(overrides: Record<string, string>): Promise<ToolDefinition[]> {
  const config = loadConfig({ ...BASE_ENV, ...overrides } as NodeJS.ProcessEnv, 'stdio');
  const { server } = buildServer({ config, transport: 'stdio' });
  const client = new Client({ name: 'tool-quality', version: '0.0.0' }, {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools as unknown as ToolDefinition[];
  } finally {
    await client.close();
    await server.close();
  }
}

interface ScoredTool {
  name: string;
  signals: ContextualSignals;
  descriptionLength: number;
}

interface DeploymentReport {
  deployment: string;
  toolCount: number;
  tier: ReturnType<typeof toolCountTier>;
  tools: ScoredTool[];
  failures: GateFailure[];
  shadowing: ShadowingCandidate[];
}

function score(deployment: string, tools: ToolDefinition[]): DeploymentReport {
  const names = new Set(tools.map((t) => t.name));
  const scored = tools.map((tool) => ({
    name: tool.name,
    signals: contextualSignals(tool),
    descriptionLength: (tool.description ?? '').length,
  }));
  return {
    deployment,
    toolCount: tools.length,
    tier: toolCountTier(tools.length),
    tools: scored,
    failures: tools.flatMap((tool) => gates(tool, names, PREFIX)),
    shadowing: shadowingCandidates(
      scored.map((t) => ({ name: t.name, cost: t.signals.invocationCost })),
      sameArea,
    ),
  };
}

/** `eurodns_dns_get_zone` and `eurodns_dns_save_zone` share an area; the compat pair has none. */
const areaOf = (name: string): string | undefined =>
  name.startsWith(PREFIX) ? name.slice(PREFIX.length).split('_')[0] : undefined;
const sameArea = (a: string, b: string): boolean =>
  areaOf(a) !== undefined && areaOf(a) === areaOf(b);

const yes = (value: boolean) => (value ? 'yes' : 'no');

function render(report: DeploymentReport): string {
  const lines: string[] = [];
  lines.push(`## ${report.deployment}: ${report.toolCount} tools`);
  lines.push('');
  lines.push(
    `Tool count anchor: **${report.tier.score}/5** — ${report.tier.anchor}. ` +
      `Gates failed: **${report.failures.length}**. Shadowing candidates: ${report.shadowing.length}.`,
  );
  lines.push('');

  if (report.failures.length > 0) {
    lines.push('### Gates');
    lines.push('');
    lines.push('| Tool | Gate | Detail |');
    lines.push('|---|---|---|');
    for (const f of report.failures) lines.push(`| ${f.tool} | ${f.gate} | ${f.detail} |`);
    lines.push('');
  }

  if (report.shadowing.length > 0) {
    lines.push(
      '### Shadowing candidates, within one area (a reader decides whether the purposes overlap)',
    );
    lines.push('');
    lines.push('| Dearer tool | Cost | Cheaper sibling | Cost |');
    lines.push('|---|---:|---|---:|');
    for (const s of report.shadowing) {
      lines.push(`| ${s.tool} | ${s.cost} | ${s.cheaperSibling} | ${s.cheaperCost} |`);
    }
    lines.push('');
  }

  lines.push('### Signals');
  lines.push('');
  lines.push(
    '| Tool | Params | Required | Coverage | Depth | Unions | Cost | Output | Title | Bytes | Description |',
  );
  lines.push('|---|---:|---:|---:|---:|---:|---:|---|---|---:|---:|');
  for (const t of report.tools) {
    const s = t.signals;
    lines.push(
      `| ${t.name} | ${s.paramCount} | ${s.requiredParamCount} | ${s.schemaDescriptionCoverage}% | ` +
        `${s.schemaDepth} | ${s.unionChoiceCount} | ${s.invocationCost} | ${yes(s.hasOutputSchema)} | ` +
        `${yes(s.titleIsMeaningful)} | ${s.definitionBytes} | ${t.descriptionLength} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<number> {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;

  const catalogue: Record<string, ToolDefinition[]> = {};
  const reports: DeploymentReport[] = [];
  for (const [deployment, overrides] of Object.entries(DEPLOYMENTS)) {
    const tools = await listTools(overrides);
    catalogue[deployment] = tools;
    reports.push(score(deployment, tools));
  }

  const markdown = `# Tool definition quality\n\n${reports.map(render).join('\n')}`;
  process.stdout.write(`${markdown}\n`);

  // The job summary is the place a reviewer looks first; stdout is for a terminal.
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${markdown}\n`);

  if (outDir !== undefined) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'tool-catalogue.json'), `${JSON.stringify(catalogue, null, 2)}\n`);
    writeFileSync(join(outDir, 'tool-quality.md'), `${markdown}\n`);
  }

  const failed = reports.reduce((n, r) => n + r.failures.length, 0);
  if (failed > 0) {
    console.error(`${failed} gate failure(s); see the report above.`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
