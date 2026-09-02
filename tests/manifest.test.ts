import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function json(name: string): Record<string, never> {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8'));
}

/**
 * The registry publishes nothing but metadata, and it checks that metadata against npm before
 * accepting it: the `mcpName` in package.json must equal the server name in server.json, and
 * server.json's version must equal the version actually published.
 *
 * When they disagree the registry answers "validation failed" without naming the field, which
 * is a bad way to find out. release-please keeps the two version fields in step through
 * `extra-files`; this asserts that it is still doing so, and that nobody renamed one side of a
 * pair by hand.
 */
describe('the published identity', () => {
  const pkg = json('package.json') as unknown as {
    name: string;
    version: string;
    mcpName: string;
    publishConfig?: { access?: string };
  };
  const server = json('server.json') as unknown as {
    name: string;
    version: string;
    packages: { identifier: string; version: string; registryType: string }[];
  };

  it('names the same server on both sides', () => {
    expect(pkg.mcpName).toBe(server.name);
    // The registry namespace is what proves ownership of the name; anything else is rejected.
    expect(server.name).toMatch(/^io\.github\./);
  });

  it('points at the package this repository actually publishes', () => {
    const npmPackage = server.packages.find((entry) => entry.registryType === 'npm');
    expect(npmPackage?.identifier).toBe(pkg.name);
  });

  /** Three version fields, one release. release-please updates the two in server.json. */
  it('carries one version, not three', () => {
    expect(server.version).toBe(pkg.version);
    for (const entry of server.packages) expect(entry.version).toBe(pkg.version);
  });

  /**
   * The lockfile carries its own copy of the name, and renaming the package does not touch
   * it: `npm install --package-lock-only` does. `npm ci` tolerates the mismatch, so nothing
   * fails — the two simply disagree about what this package is called, quietly, until someone
   * reads the published tarball's lockfile and wonders. That is how it survived the rename
   * that introduced it.
   */
  it('agrees with the lockfile about its own name', () => {
    const lock = json('package-lock.json') as unknown as {
      name: string;
      version: string;
      packages: Record<string, { name?: string; version?: string }>;
    };

    expect(lock.name).toBe(pkg.name);
    expect(lock.version).toBe(pkg.version);
    // The root entry repeats both, and `npm install --package-lock-only` rewrites all four.
    expect(lock.packages['']?.name).toBe(pkg.name);
    expect(lock.packages['']?.version).toBe(pkg.version);
  });

  /**
   * A scoped package is restricted by default. Without this field the first publish either
   * fails outright or, worse, succeeds privately — a package nobody can install, which looks
   * exactly like one that was never published.
   */
  it('publishes the scoped package publicly', () => {
    expect(pkg.name.startsWith('@')).toBe(true);
    expect(pkg.publishConfig?.access).toBe('public');
  });
});
