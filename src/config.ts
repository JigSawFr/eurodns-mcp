import { z } from 'zod';
import {
  DEFAULT_AUDIT_FORWARD_BACKOFF_MS,
  DEFAULT_AUDIT_FORWARD_BATCH,
  DEFAULT_AUDIT_FORWARD_INTERVAL_MS,
  DEFAULT_AUDIT_FORWARD_QUEUE,
  DEFAULT_AUDIT_FORWARD_RETRIES,
  DEFAULT_AUDIT_MAX_BYTES,
  DEFAULT_RATE_LIMIT,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_BASE_URL,
  DEFAULT_CHARACTER_LIMIT,
  DEFAULT_JWT_ALGORITHMS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
} from './constants.js';

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const intFromEnv = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive());

/** Credentials and behaviour for the upstream EuroDNS API. */
const upstreamSchema = z.object({
  appId: z.string().min(1, 'EURODNS_APP_ID is required'),
  apiKey: z.string().min(1, 'EURODNS_API_KEY is required'),
  baseUrl: z.string().url().default(DEFAULT_BASE_URL),
  timeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  characterLimit: z.number().int().positive(),
});

export type UpstreamConfig = z.infer<typeof upstreamSchema>;

/**
 * Which risk classes ask the caller to confirm before running.
 *
 * `off` by default: confirmation changes what a tool call does, and a deployment that never
 * asked for it should not start refusing calls after an upgrade.
 */
export type ConfirmMode = 'off' | 'destructive' | 'all';

/** Which risk classes may run at all, independently of any per-user scope. */
export interface GuardrailConfig {
  readOnly: boolean;
  allowBilling: boolean;
  allowDestructive: boolean;
  /** `all` also covers billing. Never a substitute for the switches above. */
  confirm: ConfirmMode;
}

export type AuditDestination = 'stderr' | 'stdout' | 'file' | 'none';

/**
 * Who may read the audit log back through the server.
 *
 * `own` is the useful default once enabled: a caller sees their own history, which answers
 * "what did I change last week" without turning every token into a way to watch colleagues.
 */
export type AuditQueryMode = 'off' | 'own' | 'all';

export interface AuditConfig {
  destination: AuditDestination;
  filePath?: string;
  query: AuditQueryMode;
  /** Size at which a file destination rotates. Ignored by the other destinations. */
  maxBytes: number;
  /** Set when lines are also shipped to a collector. Independent of `destination`. */
  forward?: AuditForwardConfig;
}

/**
 * Where audit lines are shipped, alongside whatever `destination` records locally.
 *
 * Deliberately additive: `EURODNS_AUDIT_QUERY` needs the `file` destination, so making
 * this a destination of its own would force a choice between shipping the log and being
 * able to ask about it.
 */
export interface AuditForwardConfig {
  url: string;
  token?: string;
  /** Lines per request, and the threshold that sends one early. */
  batch: number;
  /** How long a partial batch waits before it is sent anyway. */
  intervalMs: number;
  /** Lines held while the collector is unreachable, before the oldest are dropped. */
  queue: number;
  maxRetries: number;
  backoffMs: number;
}

export type AuthMode = 'oauth' | 'token' | 'none';

export interface OAuthConfig {
  issuer: string;
  audience: string;
  jwksUri?: string;
  subjectClaim: string;
  scopeClaim?: string;
  /**
   * The claim naming what the *person* is entitled to, when that is a different question
   * from what the client asked for.
   *
   * Unset, the token's scopes are taken as granted and that is the whole test. Set, the
   * effective permissions become the intersection of the scope claim and this one: the
   * client must have requested the scope *and* the identity provider must have assigned it
   * to the caller. See `effectiveScopes` in `auth/verifier.ts`.
   */
  roleClaim?: string;
  /**
   * A prefix the identity provider puts in front of our scope names inside `roleClaim`,
   * stripped before comparing. `''` when there is none.
   *
   * Needed because Microsoft Entra ID keeps app roles and delegated scopes in **one**
   * namespace per application: a role cannot be named `eurodns.read` while a scope of that
   * name is already exposed. The prefix is how the two are told apart without giving up the
   * correspondence between them.
   */
  rolePrefix: string;
  /** Signature algorithms a token may be signed with. Never empty. */
  algorithms: string[];
  /**
   * Prefix the advertised form of a scope carries, or `''` for none.
   *
   * Only ever applied on the way out — see `advertisedScope` in `auth/scopes.ts`. Always
   * ends in `/` when it is not empty, so callers concatenate without deciding.
   */
  scopePrefix: string;
}

export interface HttpConfig {
  host: string;
  port: number;
  /** Canonical public URI of this server, used as the OAuth resource identifier. */
  publicUrl?: string;
  authMode: AuthMode;
  staticToken?: string;
  staticTokenLabel: string;
  allowedOrigins: string[];
  /** Largest JSON body accepted, in bytes. Enforced before authentication. */
  maxBodyBytes: number;
  /** Whether `/` serves the landing page. Off returns the same 404 as any unknown path. */
  landingPage: boolean;
  /**
   * Bearer secret for `/metrics`. Unset means the endpoint does not exist.
   *
   * One variable rather than an enable flag and a credential: the endpoint reveals which
   * tools a deployment runs and how often they are refused, which is not secret but is not
   * for anyone who finds the host either. Requiring the secret to turn it on removes the
   * configuration where it is exposed by accident.
   */
  metricsToken?: string;
  /** Requests allowed per window on the MCP endpoint. `0` disables the limiter. */
  rateLimit: number;
  rateLimitWindowMs: number;
  /**
   * How many proxy hops to trust for the client address.
   *
   * Off by default, and that default is the safe one: behind a reverse proxy `req.ip` is the
   * proxy's, so a limiter keyed on it becomes one shared counter for every caller — worse
   * than no limiter, because it looks like protection while throttling everyone together.
   * Set this only to the number of proxies you actually control.
   */
  trustProxy: number;
  oauth?: OAuthConfig;
}

export interface Config {
  upstream: UpstreamConfig;
  guardrails: GuardrailConfig;
  audit: AuditConfig;
  http: HttpConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  label: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || label}: ${i.message}`);
    throw new ConfigError(`Invalid configuration — ${detail.join('; ')}`);
  }
  return result.data;
}

/**
 * Builds the configuration from environment variables.
 *
 * `transport` matters for one reason: on stdio the process' stdout carries the JSON-RPC
 * stream, so writing the audit log there would corrupt every response. Asking for
 * `stdout` under stdio is refused rather than silently redirected.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  transport: 'stdio' | 'http' = 'stdio',
): Config {
  const upstream = parseOrThrow(
    upstreamSchema,
    {
      appId: env.EURODNS_APP_ID ?? '',
      apiKey: env.EURODNS_API_KEY ?? '',
      baseUrl: env.EURODNS_BASE_URL || DEFAULT_BASE_URL,
      timeoutMs: parseOrThrow(intFromEnv(DEFAULT_TIMEOUT_MS), env.EURODNS_TIMEOUT_MS, 'timeout'),
      maxRetries: parseOrThrow(
        z
          .string()
          .optional()
          .transform((v) => (v === undefined || v === '' ? DEFAULT_MAX_RETRIES : Number(v)))
          .pipe(z.number().int().nonnegative()),
        env.EURODNS_MAX_RETRIES,
        'retries',
      ),
      characterLimit: parseOrThrow(
        intFromEnv(DEFAULT_CHARACTER_LIMIT),
        env.EURODNS_CHARACTER_LIMIT,
        'characterLimit',
      ),
    },
    'upstream',
  );

  const guardrails: GuardrailConfig = {
    readOnly: parseOrThrow(booleanFromEnv, env.EURODNS_READ_ONLY, 'EURODNS_READ_ONLY'),
    allowBilling: parseOrThrow(booleanFromEnv, env.EURODNS_ALLOW_BILLING, 'EURODNS_ALLOW_BILLING'),
    allowDestructive: parseOrThrow(
      booleanFromEnv,
      env.EURODNS_ALLOW_DESTRUCTIVE,
      'EURODNS_ALLOW_DESTRUCTIVE',
    ),
    confirm: parseOrThrow(
      z
        .enum(['off', 'destructive', 'all'])
        .optional()
        .transform((v) => v ?? 'off'),
      (env.EURODNS_CONFIRM || '').trim() === '' ? undefined : env.EURODNS_CONFIRM?.trim(),
      'EURODNS_CONFIRM',
    ),
  };

  const audit = loadAuditConfig(env, transport);
  const http = loadHttpConfig(env, transport);

  return { upstream, guardrails, audit, http };
}

function loadAuditConfig(env: NodeJS.ProcessEnv, transport: 'stdio' | 'http'): AuditConfig {
  const requested = (env.EURODNS_AUDIT_DESTINATION || '').trim();
  const destination = parseOrThrow(
    z
      .enum(['stderr', 'stdout', 'file', 'none'])
      .optional()
      .transform((v) => v ?? 'stderr'),
    requested === '' ? undefined : requested,
    'EURODNS_AUDIT_DESTINATION',
  );

  if (destination === 'stdout' && transport === 'stdio') {
    throw new ConfigError(
      'EURODNS_AUDIT_DESTINATION=stdout cannot be used with the stdio transport: stdout ' +
        'carries the JSON-RPC stream and audit lines would corrupt it. Use "stderr" or "file".',
    );
  }

  const query = parseOrThrow(
    z
      .enum(['off', 'own', 'all'])
      .optional()
      .transform((v) => v ?? 'off'),
    (env.EURODNS_AUDIT_QUERY || '').trim() === '' ? undefined : env.EURODNS_AUDIT_QUERY?.trim(),
    'EURODNS_AUDIT_QUERY',
  );

  if (query !== 'off' && destination !== 'file') {
    throw new ConfigError(
      `EURODNS_AUDIT_QUERY=${query} requires EURODNS_AUDIT_DESTINATION=file. The log can only ` +
        'be read back from a file — stderr and stdout are write-only streams.',
    );
  }

  const maxBytes = parseOrThrow(
    intFromEnv(DEFAULT_AUDIT_MAX_BYTES),
    env.EURODNS_AUDIT_MAX_BYTES,
    'EURODNS_AUDIT_MAX_BYTES',
  );

  const forward = loadAuditForwardConfig(env);

  if (destination === 'file') {
    const filePath = (env.EURODNS_AUDIT_FILE || '').trim();
    if (filePath === '') {
      throw new ConfigError(
        'EURODNS_AUDIT_DESTINATION=file requires EURODNS_AUDIT_FILE to name the target file.',
      );
    }
    return { destination, filePath, query, maxBytes, ...(forward ? { forward } : {}) };
  }

  return { destination, query, maxBytes, ...(forward ? { forward } : {}) };
}

/**
 * Reads the collector settings, or returns undefined when none are set.
 *
 * Applies to every destination and both transports: shipping lines off the host is
 * orthogonal to what is recorded locally, and `none` plus a collector is a legitimate
 * choice on a host with no writable disk.
 */
function loadAuditForwardConfig(env: NodeJS.ProcessEnv): AuditForwardConfig | undefined {
  const raw = (env.EURODNS_AUDIT_FORWARD_URL || '').trim();
  const token = (env.EURODNS_AUDIT_FORWARD_TOKEN || '').trim();

  if (raw === '') {
    // A token with nowhere to send it is a half-finished configuration, and silence would
    // let a deployment believe its audit log is being shipped when nothing is.
    if (token !== '') {
      throw new ConfigError(
        'EURODNS_AUDIT_FORWARD_TOKEN is set but EURODNS_AUDIT_FORWARD_URL is not, so nothing ' +
          'is being shipped. Set the URL, or unset the token.',
      );
    }
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`EURODNS_AUDIT_FORWARD_URL is not a valid URL: ${raw}`);
  }

  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError(
      'EURODNS_AUDIT_FORWARD_URL must use https. The audit log names who changed what, and ' +
        'sending it in the clear defeats the point of keeping it. Plain http is accepted ' +
        'only for a loopback address, where a sidecar collector is the usual arrangement.',
    );
  }

  return {
    url: url.toString(),
    ...(token === '' ? {} : { token }),
    batch: parseOrThrow(
      intFromEnv(DEFAULT_AUDIT_FORWARD_BATCH),
      env.EURODNS_AUDIT_FORWARD_BATCH,
      'EURODNS_AUDIT_FORWARD_BATCH',
    ),
    intervalMs: parseOrThrow(
      intFromEnv(DEFAULT_AUDIT_FORWARD_INTERVAL_MS),
      env.EURODNS_AUDIT_FORWARD_INTERVAL_MS,
      'EURODNS_AUDIT_FORWARD_INTERVAL_MS',
    ),
    queue: parseOrThrow(
      intFromEnv(DEFAULT_AUDIT_FORWARD_QUEUE),
      env.EURODNS_AUDIT_FORWARD_QUEUE,
      'EURODNS_AUDIT_FORWARD_QUEUE',
    ),
    maxRetries: DEFAULT_AUDIT_FORWARD_RETRIES,
    backoffMs: DEFAULT_AUDIT_FORWARD_BACKOFF_MS,
  };
}

/**
 * Normalizes the scope prefix so the rest of the code can concatenate blindly.
 *
 * Unset means "advertise scopes as they are named", which is what every authorization server
 * that takes bare scope names expects. A trailing slash is added when it is missing, because
 * `api://<app-id>` and `api://<app-id>/` are the same thing to the operator writing it and
 * only one of them produces a usable scope.
 */
function normalizeScopePrefix(raw: string | undefined): string {
  const prefix = (raw || '').trim();
  if (prefix === '') return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

function loadHttpConfig(env: NodeJS.ProcessEnv, transport: 'stdio' | 'http'): HttpConfig {
  const authMode = parseOrThrow(
    z
      .enum(['oauth', 'token', 'none'])
      .optional()
      .transform((v) => v ?? 'none'),
    (env.EURODNS_MCP_AUTH || '').trim() === '' ? undefined : env.EURODNS_MCP_AUTH?.trim(),
    'EURODNS_MCP_AUTH',
  );

  const host = (env.HOST || '127.0.0.1').trim();
  const port = parseOrThrow(intFromEnv(3000), env.PORT, 'PORT');
  const publicUrl = (env.EURODNS_MCP_PUBLIC_URL || '').trim() || undefined;
  const allowedOrigins = (env.EURODNS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');

  const config: HttpConfig = {
    host,
    port,
    publicUrl,
    authMode,
    staticTokenLabel: (env.EURODNS_MCP_TOKEN_LABEL || 'static-token').trim(),
    allowedOrigins,
    // On unless an operator says otherwise. The page names nothing a `401` and the protected
    // resource metadata do not already publish, but an operator may still prefer an address
    // that identifies itself to no one, and that is their call to make.
    landingPage: (env.EURODNS_LANDING_PAGE || 'on').trim().toLowerCase() !== 'off',
    maxBodyBytes: parseOrThrow(
      intFromEnv(DEFAULT_MAX_BODY_BYTES),
      env.EURODNS_MAX_BODY_BYTES,
      'EURODNS_MAX_BODY_BYTES',
    ),
    // Zero is meaningful here — it turns the limiter off — so this cannot use intFromEnv,
    // which requires a positive integer.
    rateLimit: parseOrThrow(
      z
        .string()
        .optional()
        .transform((v) => (v === undefined || v === '' ? DEFAULT_RATE_LIMIT : Number(v)))
        .pipe(z.number().int().nonnegative()),
      env.EURODNS_RATE_LIMIT,
      'EURODNS_RATE_LIMIT',
    ),
    rateLimitWindowMs: parseOrThrow(
      intFromEnv(DEFAULT_RATE_LIMIT_WINDOW_MS),
      env.EURODNS_RATE_LIMIT_WINDOW_MS,
      'EURODNS_RATE_LIMIT_WINDOW_MS',
    ),
    trustProxy: parseOrThrow(
      z
        .string()
        .optional()
        .transform((v) => (v === undefined || v === '' ? 0 : Number(v)))
        .pipe(z.number().int().nonnegative()),
      env.EURODNS_TRUST_PROXY,
      'EURODNS_TRUST_PROXY',
    ),
  };

  // Everything below is HTTP-only. Under stdio there is no listener, so none of it applies
  // and validating it would only produce complaints about settings that do nothing.
  if (transport !== 'http') return config;

  const metricsToken = (env.EURODNS_METRICS_TOKEN || '').trim();
  if (metricsToken !== '') {
    if (metricsToken.length < 32) {
      throw new ConfigError(
        'EURODNS_METRICS_TOKEN must be at least 32 characters. Unset it to disable the ' +
          'metrics endpoint entirely.',
      );
    }
    config.metricsToken = metricsToken;
  }

  // A server reachable from outside the loopback interface must authenticate its callers.
  if (authMode === 'none' && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new ConfigError(
      `Refusing to listen on ${host} with EURODNS_MCP_AUTH=none. Bind to 127.0.0.1 for local ` +
        'development, or set EURODNS_MCP_AUTH to "token" or "oauth".',
    );
  }

  if (authMode === 'token') {
    const token = env.EURODNS_MCP_TOKEN || '';
    if (token.length < 32) {
      throw new ConfigError(
        'EURODNS_MCP_AUTH=token requires EURODNS_MCP_TOKEN to be at least 32 characters.',
      );
    }
    config.staticToken = token;
  }

  if (authMode === 'oauth') {
    const issuer = (env.EURODNS_OAUTH_ISSUER || '').trim();
    const audience = (env.EURODNS_OAUTH_AUDIENCE || '').trim() || publicUrl || '';
    if (issuer === '') {
      throw new ConfigError('EURODNS_MCP_AUTH=oauth requires EURODNS_OAUTH_ISSUER.');
    }
    if (audience === '') {
      throw new ConfigError(
        'EURODNS_MCP_AUTH=oauth requires EURODNS_OAUTH_AUDIENCE (or EURODNS_MCP_PUBLIC_URL) so ' +
          'that tokens issued for another resource can be rejected.',
      );
    }
    const algorithms = (env.EURODNS_OAUTH_ALGORITHMS || '')
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a !== '');
    if (env.EURODNS_OAUTH_ALGORITHMS !== undefined && algorithms.length === 0) {
      throw new ConfigError(
        'EURODNS_OAUTH_ALGORITHMS is set but names no algorithm. Leave it unset to accept the ' +
          `default asymmetric set (${DEFAULT_JWT_ALGORITHMS.join(', ')}), or name at least one.`,
      );
    }

    const scopeClaim = (env.EURODNS_OAUTH_SCOPE_CLAIM || '').trim() || undefined;
    const roleClaim = (env.EURODNS_OAUTH_ROLE_CLAIM || '').trim() || undefined;

    const rolePrefix = (env.EURODNS_OAUTH_ROLE_PREFIX || '').trim();

    // A prefix with nothing to apply it to does nothing at all, and reads as though
    // per-person permissions are on when they are not. Say so rather than start.
    if (rolePrefix !== '' && roleClaim === undefined) {
      throw new ConfigError(
        'EURODNS_OAUTH_ROLE_PREFIX is set but EURODNS_OAUTH_ROLE_CLAIM is not, so there is ' +
          'no claim to strip it from. Set the claim as well, or unset the prefix.',
      );
    }

    // Both pinned to the same claim is an intersection with itself: a silent no-op that
    // grants everything, in the one deployment that configured this to grant less. It is a
    // typo rather than a policy, so refuse it at startup instead of at every request.
    if (roleClaim !== undefined && roleClaim === scopeClaim) {
      throw new ConfigError(
        `EURODNS_OAUTH_ROLE_CLAIM and EURODNS_OAUTH_SCOPE_CLAIM both name "${roleClaim}". ` +
          'They have to be different claims — one carries what the client was granted, the ' +
          'other what the caller was assigned — or the intersection means nothing.',
      );
    }

    config.oauth = {
      issuer,
      audience,
      jwksUri: (env.EURODNS_OAUTH_JWKS_URI || '').trim() || undefined,
      subjectClaim: (env.EURODNS_OAUTH_SUBJECT_CLAIM || 'sub').trim(),
      scopeClaim,
      roleClaim,
      rolePrefix,
      algorithms: algorithms.length > 0 ? algorithms : [...DEFAULT_JWT_ALGORITHMS],
      scopePrefix: normalizeScopePrefix(env.EURODNS_OAUTH_SCOPE_PREFIX),
    };
  }

  return config;
}
