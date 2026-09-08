import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPEC_VERSION, lintServer, parseToolDefinitions, type LintReport } from 'mcp-tdqs';
import { describe, expect, it } from 'vitest';
import { connect, testConfig } from './harness.js';

/**
 * The surface a registry scores, held to the reference linter.
 *
 * Glama scores every tool this server lists with TDQS, and `mcp-tdqs` is its implementation of
 * the specification: the deterministic stages run here, on the listing a registry sees and on
 * the full surface, with no model and no key. The arithmetic is the package's to test; what
 * this test holds is that nothing on this surface trips it — no gate, no missing annotation, no
 * undescribed argument, no tool without an output schema.
 *
 * Shadow candidates are the one warning left standing. The prefilter pairs any tool with any
 * materially cheaper sibling across the whole server, so a zone save is paired with the
 * prepaid-balance read; only the coherence evaluation, which is a model call, can confirm the
 * purposes overlap, and on this surface they do not. They are reported, not failed.
 */

async function lint(overrides: Record<string, string> = {}): Promise<LintReport> {
  const { client, close } = await connect({ config: testConfig(overrides) });
  const listed = await client.listTools();
  await close();
  const { tools } = parseToolDefinitions(listed);
  return lintServer({ serverName: 'eurodns-mcp', tools });
}

const EVERYTHING = {
  EURODNS_ALLOW_BILLING: 'true',
  EURODNS_ALLOW_DESTRUCTIVE: 'true',
  EURODNS_COMPAT_TOOLS: 'true',
  EURODNS_AUDIT_DESTINATION: 'file',
  EURODNS_AUDIT_FILE: join(mkdtempSync(join(tmpdir(), 'eurodns-tdqs-')), 'audit.jsonl'),
  EURODNS_AUDIT_QUERY: 'all',
};

describe.each([
  ['a default deployment, which is what a registry lists', {}],
  ['a deployment with every class on', EVERYTHING],
])('the reference TDQS linter, on %s', (_name, overrides) => {
  it('finds nothing an agent would stumble on', async () => {
    const report = await lint(overrides);

    expect(report.specVersion).toBe(SPEC_VERSION);
    expect(report.server.toolCount).toBe(report.tools.length);

    const errors = report.findings.filter((f) => f.severity === 'error');
    expect(errors).toEqual([]);

    // The warnings the specification lists as "improving your score": every tool here
    // declares its annotations, describes every argument, and ships an output schema.
    const rules = new Set(report.findings.map((f) => f.rule));
    expect(rules.has('missing-annotations')).toBe(false);
    expect(rules.has('undocumented-parameters')).toBe(false);
    expect(rules.has('no-output-schema')).toBe(false);

    for (const tool of report.tools) {
      expect(tool.contextSignals.schemaDescriptionCoverage, tool.name).toBe(100);
      expect(tool.contextSignals.hasAnnotations, tool.name).toBe(true);
      expect(tool.contextSignals.hasOutputSchema, tool.name).toBe(true);
    }
  });
});
