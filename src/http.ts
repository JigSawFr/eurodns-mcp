#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { ConfigError, loadConfig, type Config } from './config.js';
import { OnePasswordError, resolveEnvSecrets } from './secrets/index.js';
import { ALL_SCOPES } from './constants.js';
import { SERVER_NAME, SERVER_VERSION, buildServer, hiddenClasses } from './server.js';
import { MetricsRegistry } from './metrics.js';
import { AuditLogger } from './audit.js';
import { toolScopeIndex } from './tools/registry.js';
import { scopeGate } from './auth/scopeGate.js';
import { JwtTokenVerifier, StaticTokenVerifier } from './auth/verifier.js';
import { discoverAuthorizationServer } from './auth/discovery.js';
import type { JWTVerifyGetKey } from 'jose';
import type { FetchLike } from './services/client.js';

/** Injection points, used by tests to avoid real network calls. */
export interface AppOptions {
  /** Replaces the fetch used to reach the EuroDNS API. */
  fetchImpl?: FetchLike;
  /** Replaces the fetch used for authorization-server discovery. */
  discoveryFetch?: typeof fetch;
  /** Replaces the remote JWKS lookup with a local key set. */
  jwtKeyResolver?: JWTVerifyGetKey;
  /** Supplies the process-wide counters, so a test can inspect them. */
  metrics?: MetricsRegistry;
}

const MCP_ENDPOINT = '/mcp';

/**
 * Rejects cross-origin requests from browsers, which is how a DNS-rebinding attack would
 * reach a server bound to the loopback interface. The transport has its own version of
 * this check but deprecates it in favour of external middleware, so it lives here.
 */
export function originGuard(allowedOrigins: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin === undefined) {
      // Non-browser clients send no Origin; there is nothing to rebind.
      next();
      return;
    }
    if (allowedOrigins.includes(origin)) {
      next();
      return;
    }
    res.status(403).json({
      error: 'forbidden_origin',
      error_description:
        `Origin "${origin}" is not allowed. Set EURODNS_ALLOWED_ORIGINS to a comma-separated ` +
        'list of origins permitted to reach this server.',
    });
  };
}

async function buildAuthLayer(
  app: express.Express,
  config: Config,
  options: AppOptions,
): Promise<void> {
  const { authMode, publicUrl } = config.http;
  if (authMode === 'none') return;

  let verifier: OAuthTokenVerifier;
  let resourceMetadataUrl: string | undefined;

  if (authMode === 'token') {
    verifier = new StaticTokenVerifier(
      config.http.staticToken as string,
      config.http.staticTokenLabel,
    );
  } else {
    const oauth = config.http.oauth;
    if (!oauth) throw new ConfigError('OAuth mode selected without OAuth configuration.');

    const metadata = await discoverAuthorizationServer(oauth.issuer, options.discoveryFetch);
    const jwksUri = oauth.jwksUri ?? metadata.jwks_uri;
    if (!jwksUri) {
      throw new ConfigError(
        `The authorization server "${oauth.issuer}" publishes no jwks_uri. Set ` +
          'EURODNS_OAUTH_JWKS_URI explicitly.',
      );
    }

    verifier = new JwtTokenVerifier(oauth, jwksUri, options.jwtKeyResolver);

    const resourceServerUrl = new URL(publicUrl ?? oauth.audience);
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

    // RFC 9728: advertise which authorization server issues tokens for this resource.
    app.use(
      mcpAuthMetadataRouter({
        oauthMetadata: metadata,
        resourceServerUrl,
        scopesSupported: [...ALL_SCOPES],
        resourceName: SERVER_NAME,
      }),
    );
  }

  app.use(
    MCP_ENDPOINT,
    requireBearerAuth({
      verifier,
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    }),
  );

  if (authMode === 'oauth') {
    app.use(MCP_ENDPOINT, scopeGate(toolScopeIndex()));
  }
}

export async function createApp(
  config: Config,
  options: AppOptions = {},
): Promise<express.Express> {
  const app = express();

  // Nothing gains from announcing the framework and version to an unauthenticated caller.
  app.disable('x-powered-by');

  // Only trust forwarded client addresses when an operator says how many proxies sit in
  // front. Express defaults to trusting none, and so do we — see the config comment for why
  // getting this wrong makes the limiter below worse than absent.
  if (config.http.trustProxy > 0) app.set('trust proxy', config.http.trustProxy);

  // The origin check runs before the body parser, not after: rejecting a cross-origin
  // request should not first require parsing the document it carries.
  app.use(originGuard(config.http.allowedOrigins));

  // Before the body parser and before authentication, because the flood worth absorbing is
  // the unauthenticated one: a 401 is cheap but not free, and neither is parsing a megabyte
  // to discover the caller has no token.
  //
  // Scoped to /mcp alone. /healthz has to stay reachable by platform probes that poll it
  // every few seconds, and /metrics by a monitoring system doing exactly the same — putting
  // either behind a limiter turns ordinary supervision into an outage.
  registerRateLimit(app, config);

  app.use(express.json({ limit: config.http.maxBodyBytes }));
  await buildAuthLayer(app, config, options);

  // One registry and one logger for the process. The server below is rebuilt on every call,
  // so anything that has to accumulate — counters, and the audit log's hash chain — must
  // outlive it. A logger per request would restart the chain on every call.
  const metrics = options.metrics ?? new MetricsRegistry();
  const audit = new AuditLogger(config.audit, Date.now, metrics);

  // One factory, both protocol eras. `legacy: 'stateless'` is the default and is what keeps
  // 2025-era clients — which is still most of them — working against the same endpoint while
  // the handler serves 2026-07-28 natively. The factory is called per request, which is the
  // shape this server already had: nothing is shared between callers and the deployment
  // scales without sticky sessions.
  const mcpHandler = toNodeHandler(
    createMcpHandler(
      () =>
        buildServer({
          config,
          transport: 'http',
          metrics,
          audit,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        }).server,
      { legacy: 'stateless' },
    ),
  );

  app.all(MCP_ENDPOINT, (req: Request, res: Response) => {
    // The body is already parsed by express.json above; handing it over avoids a second read
    // of a stream that has been consumed.
    void mcpHandler(req, res, req.body);
  });

  // Liveness only. The endpoint is deliberately unauthenticated so a platform health check
  // can reach it, which is also why it names no version: that would hand an unauthenticated
  // caller the exact build to look up. Clients read the version from the MCP handshake.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  registerMetricsEndpoint(app, config, metrics);

  return app;
}

/**
 * Rate-limits the MCP endpoint, when enabled.
 *
 * The store is in memory, so the count is per process. That matches the rest of this
 * deployment — the audit log is a file on one volume — but it means scaling out multiplies
 * the effective limit by the number of instances rather than sharing it.
 */
function registerRateLimit(app: express.Express, config: Config): void {
  const { rateLimit: max, rateLimitWindowMs } = config.http;
  if (max === 0) return;

  app.use(
    MCP_ENDPOINT,
    rateLimit({
      windowMs: rateLimitWindowMs,
      limit: max,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      // A JSON-RPC caller gets a JSON-RPC answer. -32000 is the implementation-defined
      // server error range; a bare HTML 429 would be parsed as a protocol violation.
      handler: (_req: Request, res: Response) => {
        res.status(429).json({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message: `Rate limit exceeded: more than ${max} requests in ${rateLimitWindowMs} ms.`,
          },
        });
      },
    }),
  );
}

/**
 * Serves counters in the Prometheus text format, when a token is configured.
 *
 * Its own secret rather than the MCP credential: the poller is a monitoring system, which
 * should not hold a token that can also change DNS. Under OAuth the MCP credential is a
 * short-lived JWT that no network management system could carry anyway.
 */
function registerMetricsEndpoint(
  app: express.Express,
  config: Config,
  metrics: MetricsRegistry,
): void {
  const token = config.http.metricsToken;
  if (token === undefined) return;

  const expected = createHash('sha256').update(token, 'utf8').digest();
  let toolCount: number | undefined;

  app.get('/metrics', (req: Request, res: Response) => {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const matches = timingSafeEqual(
      createHash('sha256').update(presented, 'utf8').digest(),
      expected,
    );

    if (!matches) {
      res.set('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // Counted once: the tool surface is fixed by configuration, and building a server to
    // ask again on every scrape would be pure waste.
    toolCount ??= buildServer({ config, transport: 'http' }).toolCount;

    res.type('text/plain; version=0.0.4; charset=utf-8').send(
      metrics.render({
        version: SERVER_VERSION,
        toolCount,
        ...(config.audit.destination === 'file' && config.audit.filePath
          ? { auditFile: config.audit.filePath }
          : {}),
      }),
    );
  });
}

async function main(): Promise<void> {
  const config = loadConfig(await resolveEnvSecrets(process.env), 'http');
  const app = await createApp(config);
  const { host, port, authMode } = config.http;

  app.listen(port, host, () => {
    const { toolCount } = buildServer({ config, transport: 'http' });
    const hidden = hiddenClasses(config);
    process.stderr.write(
      `${SERVER_NAME} ${SERVER_VERSION} listening on http://${host}:${port}${MCP_ENDPOINT} ` +
        `(auth: ${authMode}, ${toolCount} tools` +
        `${hidden.length ? `, hidden: ${hidden.join(', ')}` : ''})\n`,
    );
  });
}

/** Only start listening when this module is the process entry point, not when imported. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError || error instanceof OnePasswordError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
