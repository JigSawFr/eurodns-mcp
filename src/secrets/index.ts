import { OnePasswordConnectClient, OnePasswordError, connectConfigFrom } from './onepassword.js';
import { isSecretReference } from './reference.js';

export { OnePasswordError } from './onepassword.js';
export { SecretReferenceError, parseSecretReference } from './reference.js';

/**
 * Resolves 1Password references found in the environment.
 *
 * Any `EURODNS_*` variable may hold either a literal value or an `op://vault/item/field`
 * reference. This is an additional way to obtain a secret, not a required one: an
 * environment with no references never contacts 1Password, and the server has no dependency
 * on it.
 *
 * Resolution happens once, at startup. A value rotated in 1Password afterwards is picked up
 * on the next restart.
 */
export async function resolveEnvSecrets(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<NodeJS.ProcessEnv> {
  const references = Object.entries(env).filter(
    (entry): entry is [string, string] =>
      entry[0].startsWith('EURODNS_') &&
      typeof entry[1] === 'string' &&
      isSecretReference(entry[1]),
  );

  if (references.length === 0) return env;

  const connect = connectConfigFrom(env);
  if (!connect) {
    const names = references.map(([name]) => name).join(', ');
    throw new OnePasswordError(
      `${names} ${references.length === 1 ? 'holds a' : 'hold'} 1Password reference, but no ` +
        'Connect server is configured. Set OP_CONNECT_HOST and OP_CONNECT_TOKEN, or replace ' +
        'the reference with a literal value.',
    );
  }

  const client = new OnePasswordConnectClient(connect, fetchImpl);
  const resolved: NodeJS.ProcessEnv = { ...env };

  for (const [name, reference] of references) {
    // Errors carry the reference and the failing step, never the value.
    resolved[name] = await client.resolve(reference);
  }

  return resolved;
}
