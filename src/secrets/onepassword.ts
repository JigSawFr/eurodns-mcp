import { looksLikeId, parseSecretReference, type SecretReference } from './reference.js';

/**
 * Minimal client for a 1Password Connect server.
 *
 * This is deliberately not the `@1password/connect` SDK. The SDK does not resolve `op://`
 * references — it exposes item and vault lookups — so the parsing and field selection would
 * have to be written either way. Calling the REST API directly keeps this an additional way
 * to obtain a secret rather than a dependency everyone installs, including those who never
 * use 1Password.
 */

export class OnePasswordError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OnePasswordError';
  }
}

export interface ConnectConfig {
  host: string;
  token: string;
}

interface VaultSummary {
  id?: string;
  name?: string;
}

interface ItemSummary {
  id?: string;
  title?: string;
}

interface ItemField {
  id?: string;
  label?: string;
  value?: string;
  section?: { id?: string; label?: string };
}

interface ItemDetail {
  id?: string;
  title?: string;
  fields?: ItemField[];
  sections?: Array<{ id?: string; label?: string }>;
}

/** Reads `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN`, or returns null when unconfigured. */
export function connectConfigFrom(env: NodeJS.ProcessEnv): ConnectConfig | null {
  const host = (env.OP_CONNECT_HOST || '').trim();
  const token = (env.OP_CONNECT_TOKEN || '').trim();
  if (host === '' || token === '') return null;
  return { host: host.replace(/\/$/, ''), token };
}

export class OnePasswordConnectClient {
  private readonly config: ConnectConfig;
  private readonly fetchImpl: typeof fetch;
  /** One resolution per reference for the lifetime of a startup. */
  private readonly cache = new Map<string, Promise<string>>();

  constructor(config: ConnectConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  resolve(raw: string): Promise<string> {
    const cached = this.cache.get(raw);
    if (cached) return cached;

    const pending = this.resolveUncached(raw);
    this.cache.set(raw, pending);
    return pending;
  }

  private async resolveUncached(raw: string): Promise<string> {
    const reference = parseSecretReference(raw);
    const vaultId = await this.resolveVaultId(reference);
    const itemId = await this.resolveItemId(reference, vaultId);
    const item = await this.request<ItemDetail>(
      `/v1/vaults/${vaultId}/items/${itemId}`,
      reference,
      'reading the item',
    );
    return selectField(item, reference);
  }

  private async resolveVaultId(reference: SecretReference): Promise<string> {
    if (looksLikeId(reference.vault)) return reference.vault;

    const vaults = await this.request<VaultSummary[]>(
      `/v1/vaults?filter=${encodeURIComponent(`name eq "${reference.vault}"`)}`,
      reference,
      'looking up the vault',
    );
    const id = vaults?.[0]?.id;
    if (!id) {
      throw new OnePasswordError(
        `1Password Connect has no vault named "${reference.vault}" (from ${reference.raw}). ` +
          'Check the vault name, and that the Connect token grants access to it.',
      );
    }
    return id;
  }

  private async resolveItemId(reference: SecretReference, vaultId: string): Promise<string> {
    if (looksLikeId(reference.item)) return reference.item;

    const items = await this.request<ItemSummary[]>(
      `/v1/vaults/${vaultId}/items?filter=${encodeURIComponent(`title eq "${reference.item}"`)}`,
      reference,
      'looking up the item',
    );
    const id = items?.[0]?.id;
    if (!id) {
      throw new OnePasswordError(
        `Vault "${reference.vault}" has no item titled "${reference.item}" ` +
          `(from ${reference.raw}).`,
      );
    }
    return id;
  }

  private async request<T>(path: string, reference: SecretReference, step: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.host}${path}`, {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: 'application/json',
        },
      });
    } catch (cause) {
      throw new OnePasswordError(
        `Could not reach 1Password Connect at ${this.config.host} while ${step} for ` +
          `${reference.raw}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new OnePasswordError(
        `1Password Connect refused the token while ${step} for ${reference.raw} ` +
          `(HTTP ${response.status}). Check OP_CONNECT_TOKEN and the vaults it grants.`,
      );
    }

    if (!response.ok) {
      throw new OnePasswordError(
        `1Password Connect returned HTTP ${response.status} while ${step} for ${reference.raw}.`,
      );
    }

    return (await response.json()) as T;
  }
}

/**
 * Picks the referenced field from an item.
 *
 * Fields are matched on their label, and failing that on their id, so that the well-known
 * ids (`username`, `password`, `credential`) work as field names the way the 1Password apps
 * present them.
 */
export function selectField(item: ItemDetail, reference: SecretReference): string {
  const fields = item.fields ?? [];

  const inSection = (field: ItemField): boolean => {
    if (reference.section === undefined) return true;
    const sectionId = field.section?.id;
    const label =
      field.section?.label ?? item.sections?.find((s) => s.id === sectionId)?.label ?? undefined;
    return label === reference.section || sectionId === reference.section;
  };

  const match =
    fields.find((field) => inSection(field) && field.label === reference.field) ??
    fields.find((field) => inSection(field) && field.id === reference.field);

  if (!match) {
    throw new OnePasswordError(
      `Item "${reference.item}" has no field "${reference.field}"` +
        (reference.section ? ` in section "${reference.section}"` : '') +
        ` (from ${reference.raw}).`,
    );
  }

  if (typeof match.value !== 'string' || match.value === '') {
    throw new OnePasswordError(
      `Field "${reference.field}" of item "${reference.item}" is empty (from ${reference.raw}).`,
    );
  }

  return match.value;
}
