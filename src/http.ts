#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { OnePasswordError, resolveEnvSecrets } from './secrets/index.js';
import { ALL_SCOPES } from './constants.js';
import { SERVER_NAME, SERVER_VERSION, buildServer } from './server.js';
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
  app.use(express.json({ limit: '4mb' }));
  app.use(originGuard(config.http.allowedOrigins));
  await buildAuthLayer(app, config, options);

  app.post(MCP_ENDPOINT, async (req: Request, res: Response) => {
    // Stateless: a fresh server and transport per request, so nothing is shared between
    // callers and the deployment scales without sticky sessions.
    const { server } = buildServer({
      config,
      transport: 'http',
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION });
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig(await resolveEnvSecrets(process.env), 'http');
  const app = await createApp(config);
  const { host, port, authMode } = config.http;

  app.listen(port, host, () => {
    const { toolCount } = buildServer({ config, transport: 'http' });
    process.stderr.write(
      `${SERVER_NAME} ${SERVER_VERSION} listening on http://${host}:${port}${MCP_ENDPOINT} ` +
        `(auth: ${authMode}, ${toolCount} tools)\n`,
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
