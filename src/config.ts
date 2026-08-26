import { z } from 'zod';
import {
  DEFAULT_AUDIT_MAX_BYTES,
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

/** Which risk classes may run at all, independently of any per-user scope. */
export interface GuardrailConfig {
  readOnly: boolean;
  allowBilling: boolean;
  allowDestructive: boolean;
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
}

export type AuthMode = 'oauth' | 'token' | 'none';

export interface OAuthConfig {
  issuer: string;
  audience: string;
  jwksUri?: string;
  subjectClaim: string;
  scopeClaim?: string;
  /** Signature algorithms a token may be signed with. Never empty. */
  algorithms: string[];
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
  /**
   * Bearer secret for `/metrics`. Unset means the endpoint does not exist.
   *
   * One variable rather than an enable flag and a credential: the endpoint reveals which
   * tools a deployment runs and how often they are refused, which is not secret but is not
   * for anyone who finds the host either. Requiring the secret to turn it on removes the
   * configuration where it is exposed by accident.
   */
  metricsToken?: string;
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

  if (destination === 'file') {
    const filePath = (env.EURODNS_AUDIT_FILE || '').trim();
    if (filePath === '') {
      throw new ConfigError(
        'EURODNS_AUDIT_DESTINATION=file requires EURODNS_AUDIT_FILE to name the target file.',
      );
    }
    return { destination, filePath, query, maxBytes };
  }

  return { destination, query, maxBytes };
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
    maxBodyBytes: parseOrThrow(
      intFromEnv(DEFAULT_MAX_BODY_BYTES),
      env.EURODNS_MAX_BODY_BYTES,
      'EURODNS_MAX_BODY_BYTES',
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

    config.oauth = {
      issuer,
      audience,
      jwksUri: (env.EURODNS_OAUTH_JWKS_URI || '').trim() || undefined,
      subjectClaim: (env.EURODNS_OAUTH_SUBJECT_CLAIM || 'sub').trim(),
      scopeClaim: (env.EURODNS_OAUTH_SCOPE_CLAIM || '').trim() || undefined,
      algorithms: algorithms.length > 0 ? algorithms : [...DEFAULT_JWT_ALGORITHMS],
    };
  }

  return config;
}
