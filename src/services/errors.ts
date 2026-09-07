/** Shape of the API's error envelope (`ErrorResponse` in the OpenAPI document). */
export interface UpstreamErrorPayload {
  errors?: Array<{ code?: string; title?: string }>;
}

/**
 * An error returned by the EuroDNS API, carrying the upstream status and error codes
 * plus a message written to tell an agent what to do next.
 */
export class EuroDnsApiError extends Error {
  readonly status: number;
  readonly codes: string[];
  readonly titles: string[];
  readonly method: string;
  readonly path: string;

  constructor(init: {
    status: number;
    codes: string[];
    titles: string[];
    method: string;
    path: string;
    message: string;
  }) {
    super(init.message);
    this.name = 'EuroDnsApiError';
    this.status = init.status;
    this.codes = init.codes;
    this.titles = init.titles;
    this.method = init.method;
    this.path = init.path;
  }
}

/** Raised when the upstream call never completed (timeout, DNS failure, socket error). */
export class EuroDnsTransportError extends Error {
  readonly method: string;
  readonly path: string;

  constructor(message: string, method: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EuroDnsTransportError';
    this.method = method;
    this.path = path;
  }
}

/**
 * What a caller is told when the process holds no credentials.
 *
 * Written for the model that reads it in a tool result: it says that nothing was sent, what
 * the operator has to do, and that the tool list is still real — so it does not retry, and
 * does not conclude that the account is empty or the server broken.
 */
export const UNCONFIGURED_MESSAGE =
  'Nothing was sent to the EuroDNS API: this server was started without credentials. Set ' +
  'EURODNS_APP_ID and EURODNS_API_KEY in the environment of the server process and restart ' +
  'it. Every tool is listed; none can run until then.';

/**
 * Raised before any request is built when the process was started without credentials.
 *
 * Only the stdio transport can be in this state (see `loadConfig`). The throw sits ahead of
 * URL and header construction on purpose: not even a request that would come back 401 leaves
 * the process, so a server started to be listed never touches the network.
 */
export class EuroDnsUnconfiguredError extends Error {
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string) {
    super(UNCONFIGURED_MESSAGE);
    this.name = 'EuroDnsUnconfiguredError';
    this.method = method;
    this.path = path;
  }
}

/**
 * Turns an upstream failure into a message an agent can act on.
 *
 * The API's own titles are terse and sometimes generic ("Unexpected technical error"), so
 * the well-known cases get an explicit next step appended instead.
 */
export function describeUpstreamError(args: {
  status: number;
  codes: string[];
  titles: string[];
  method: string;
  path: string;
}): string {
  const { status, codes, titles, method, path } = args;
  const upstream = titles.filter((t) => t.length > 0).join('; ');
  const base = `EuroDNS API ${method} ${path} failed with HTTP ${status}${
    upstream ? `: ${upstream}` : ''
  }`;
  const hint = hintFor(status, codes, method, path);
  return hint ? `${base}. ${hint}` : `${base}.`;
}

function hintFor(status: number, codes: string[], method: string, path: string): string | null {
  if (codes.includes('INSUFFICIENT_PREPAID_BALANCE')) {
    return 'The prepaid account has insufficient funds — check the balance before retrying.';
  }

  switch (status) {
    case 401:
      return 'Credentials were rejected. Verify the EURODNS_APP_ID and EURODNS_API_KEY environment variables of the server process.';
    case 403:
      return "Access was refused. The most common cause is the caller's public IP not being whitelisted in the EuroDNS account settings.";
    case 404:
      return path.startsWith('/dns-zones/')
        ? "No such DNS zone on this account. List or search the account's domains to get the exact zone name."
        : 'The requested resource does not exist on this account.';
    case 400:
      if (method === 'PUT' && /^\/dns-zones\/[^/]+$/.test(path)) {
        return 'The zone was rejected as invalid. Validate it first to obtain a per-record validation report instead of this generic error.';
      }
      return 'The request was rejected as malformed. Note that DNS record values use the "rdata" field, not "data".';
    case 429:
      return 'Rate limited by the API. Retry after a short delay.';
    default:
      return status >= 500
        ? 'The API reported a server-side error; retrying later may succeed.'
        : null;
  }
}

/** Extracts error codes and titles from an upstream body, tolerating any shape. */
export function extractErrors(body: unknown): { codes: string[]; titles: string[] } {
  const codes: string[] = [];
  const titles: string[] = [];
  const errors = (body as UpstreamErrorPayload | null)?.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry?.code === 'string') codes.push(entry.code);
      if (typeof entry?.title === 'string') titles.push(entry.title);
    }
  }
  return { codes, titles };
}
