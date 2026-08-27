import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TREES = ['src', 'tests', 'scripts'];

async function typescriptFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const tree of TREES) {
    const entries = await readdir(join(ROOT, tree), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.ts')) {
        found.push(join(entry.parentPath, entry.name));
      }
    }
  }
  return found;
}

describe('source hygiene', () => {
  /**
   * A raw NUL is what makes a text file "binary" to git, grep and `file`. The consequences
   * are quiet rather than loud: the file disappears from repository-wide searches and its
   * diffs stop rendering, so a change to it goes unreviewed.
   *
   * src/metrics.ts carried five of them for several releases — a NUL used as a map-key
   * separator, written as the byte instead of the escape. Both forms compile to the same
   * string, so nothing but a check like this one distinguishes them.
   */
  it('has no source file that tooling would treat as binary', async () => {
    const files = await typescriptFiles();
    expect(files.length).toBeGreaterThan(0);

    const binary = [];
    for (const file of files) {
      if ((await readFile(file)).includes(0)) binary.push(file.slice(ROOT.length));
    }

    expect(binary, `write NUL as \\u0000 rather than the byte in: ${binary.join(', ')}`).toEqual(
      [],
    );
  });
});
