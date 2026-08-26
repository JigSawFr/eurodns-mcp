/**
 * 1Password secret references.
 *
 * A reference names a field inside an item inside a vault, in either of two shapes:
 *
 *   op://vault/item/field
 *   op://vault/item/section/field
 *
 * Anything else is rejected rather than guessed at: a misread reference would send the
 * server looking for the wrong secret, and the failure would surface much later as a
 * confusing authentication error.
 */

export const SECRET_REFERENCE_PREFIX = 'op://';

export interface SecretReference {
  /** Vault name or 1Password id. */
  vault: string;
  /** Item title or 1Password id. */
  item: string;
  /** Section label, when the four-segment form is used. */
  section?: string;
  /** Field label, or a well-known id such as `password` or `credential`. */
  field: string;
  /** The original reference, for error messages. */
  raw: string;
}

export class SecretReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretReferenceError';
  }
}

export function isSecretReference(value: string): boolean {
  return value.startsWith(SECRET_REFERENCE_PREFIX);
}

/** 1Password ids are 26 lowercase alphanumeric characters. */
export function looksLikeId(value: string): boolean {
  return /^[a-z0-9]{26}$/.test(value);
}

export function parseSecretReference(raw: string): SecretReference {
  if (!isSecretReference(raw)) {
    throw new SecretReferenceError(`"${raw}" is not a 1Password secret reference.`);
  }

  const segments = raw
    .slice(SECRET_REFERENCE_PREFIX.length)
    .split('/')
    .map((segment) => decodeURIComponent(segment));

  if (segments.some((segment) => segment === '')) {
    throw new SecretReferenceError(
      `The secret reference "${raw}" has an empty segment. Expected ` +
        'op://vault/item/field or op://vault/item/section/field.',
    );
  }

  if (segments.length === 3) {
    const [vault, item, field] = segments as [string, string, string];
    return { vault, item, field, raw };
  }

  if (segments.length === 4) {
    const [vault, item, section, field] = segments as [string, string, string, string];
    return { vault, item, section, field, raw };
  }

  throw new SecretReferenceError(
    `The secret reference "${raw}" has ${segments.length} segments. Expected 3 ` +
      '(op://vault/item/field) or 4 (op://vault/item/section/field).',
  );
}
