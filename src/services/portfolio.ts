import type { EuroDnsClient } from './client.js';

/** One entry of the search result, narrowed to the field this cache is about. */
interface SearchedDomain {
  domainName?: string;
}

export interface PortfolioCacheOptions {
  ttlMs: number;
  /** Hard ceiling on entries held, whatever the account contains. */
  maxEntries: number;
  /** Injectable for tests; defaults to the wall clock. */
  now?: () => number;
}

export interface RefreshResult {
  count: number;
  /** Age of the list this one replaced, absent when there was nothing to replace. */
  replacedAgeMs?: number;
}

/**
 * The account's domain names, held briefly so completion does not become a request amplifier.
 *
 * Completion is typed into, one character at a time, and the only upstream call that answers
 * "which domains exist" is a full portfolio search. Without a cache each keystroke would be
 * one of those, against an API that filters by source IP and rate-limits — the feature would
 * cost more than it is worth on the first person who types a domain name slowly.
 *
 * Three properties make it acceptable rather than merely faster:
 *
 * - **A TTL**, so a domain registered elsewhere shows up without a restart.
 * - **One request in flight at a time.** Several completions arriving together — which is the
 *   normal case, not the edge case — share a single upstream call rather than starting one
 *   each. This is the property that actually bounds the cost; the TTL alone does not, because
 *   an empty cache under concurrent load would stampede.
 * - **Failure is silent and non-fatal.** A completion that cannot be answered returns nothing.
 *   Refusing to complete is a small inconvenience; failing the request the completion was
 *   attached to would be a bug.
 *
 * It is deliberately process-wide rather than per-server: the HTTP transport builds a fresh
 * server for every request, so a cache owned by one would be empty every time and the TTL
 * would never elapse because nothing would live long enough to age.
 */
export class PortfolioCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  private names: string[] = [];
  private fetchedAt: number | undefined;
  private inFlight: Promise<string[]> | undefined;

  constructor(options: PortfolioCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
  }

  /** How long ago the held list was fetched, or undefined if nothing has been fetched. */
  ageMs(): number | undefined {
    return this.fetchedAt === undefined ? undefined : this.now() - this.fetchedAt;
  }

  /** Names matching a prefix, case-insensitively. Empty when the list cannot be obtained. */
  async complete(client: EuroDnsClient, prefix: string): Promise<string[]> {
    const names = await this.list(client);
    const needle = prefix.trim().toLowerCase();
    if (!needle) return names;
    return names.filter((name) => name.toLowerCase().includes(needle));
  }

  /** The held list, fetching first when it is missing or stale. */
  async list(client: EuroDnsClient): Promise<string[]> {
    const age = this.ageMs();
    if (age !== undefined && age < this.ttlMs) return this.names;
    return this.fetchOnce(client);
  }

  /** Discards what is held and fetches again, whatever the TTL says. */
  async refresh(client: EuroDnsClient): Promise<RefreshResult> {
    const replacedAgeMs = this.ageMs();
    this.fetchedAt = undefined;
    const names = await this.fetchOnce(client);
    return replacedAgeMs === undefined
      ? { count: names.length }
      : { count: names.length, replacedAgeMs };
  }

  /**
   * The single-flight gate.
   *
   * Callers arriving while a fetch is running await that fetch rather than starting another.
   * `finally` clears the slot whether the call succeeded or threw, so a failure does not wedge
   * every later caller onto a rejected promise.
   */
  private fetchOnce(client: EuroDnsClient): Promise<string[]> {
    this.inFlight ??= this.fetchNames(client).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchNames(client: EuroDnsClient): Promise<string[]> {
    try {
      // `size: -1` is the API's own request for every result in one page, which is the whole
      // point: one call rather than a loop whose length nothing here can predict.
      const response = await client.request<SearchedDomain[]>({
        method: 'POST',
        path: '/domains/search',
        body: {},
        pagination: { size: -1 },
      });

      const names = (Array.isArray(response.data) ? response.data : [])
        .map((entry) => entry?.domainName)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .slice(0, this.maxEntries)
        .sort((a, b) => a.localeCompare(b));

      this.names = names;
      this.fetchedAt = this.now();
      return names;
    } catch (cause) {
      // Visible, because a completion that silently stops working looks like one that has
      // nothing to suggest — but never fatal, and never a reason to lose a good older list.
      process.stderr.write(
        `${JSON.stringify({
          level: 'warn',
          message: 'portfolio lookup failed',
          detail: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
      return this.names;
    }
  }
}
