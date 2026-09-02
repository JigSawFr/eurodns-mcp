import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { NATIVE_PROTOCOL_REVISION, TOOL_LIST_CACHE_MS } from './constants.js';
import { hiddenClasses } from './instructions.js';
import { auditQueryAvailable } from './tools/audit.js';
import type { ToolContext } from './tools/context.js';

export const DEPLOYMENT_RESOURCE_URI = 'eurodns://deployment';
export const DOMAIN_RESOURCE_TEMPLATE = 'eurodns://domain/{domainName}';

/**
 * What this deployment will and will not do, readable by the client.
 *
 * Guardrails hide a tool rather than advertise it and refuse — the honest surface, but it
 * costs discoverability: the tool is simply not there, and nothing says which setting would
 * bring it back. The operator hears that on stderr at startup. Until this resource existed,
 * the client never did, and a caller wondering why it cannot renew a domain had no way to
 * find out that renewal is a class this deployment declines to expose.
 *
 * The handshake instructions name the hidden classes too, in a sentence. This carries the
 * same facts in a form something can act on, plus the ones not worth spending session tokens
 * on: the confirmation mode, whether scopes are enforced, whether history can be queried.
 *
 * It deliberately carries **no credential and no address**: not the application id, the API
 * key, the static token, the JWKS URL, nor the upstream base URL. Everything here is a
 * property of the deployment's *behaviour*. A test asserts the absence rather than the
 * presence, so a field added later cannot quietly leak one.
 */
export function deploymentState(config: Config) {
  const { guardrails, upstream, http } = config;

  return {
    protocol: { native: NATIVE_PROTOCOL_REVISION },
    guardrails: {
      readOnly: guardrails.readOnly,
      allowBilling: guardrails.allowBilling,
      allowDestructive: guardrails.allowDestructive,
      confirm: guardrails.confirm,
      // Each entry names the class and, in parentheses, the variable that would restore it.
      hidden: hiddenClasses(config),
    },
    limits: {
      characterLimit: upstream.characterLimit,
      // Not a guardrail, but the other number that decides whether a plan is realistic.
      timeoutMs: upstream.timeoutMs,
    },
    auth: {
      mode: http.authMode,
      /** Under OAuth every call must arrive with scopes; the other modes carry no identity. */
      scopesEnforced: http.authMode === 'oauth',
    },
    history: {
      queryable: auditQueryAvailable(config),
      mode: config.audit.query,
    },
  };
}

export function registerResources(server: McpServer, context: ToolContext): number {
  server.registerResource(
    'deployment',
    DEPLOYMENT_RESOURCE_URI,
    {
      title: 'What this deployment allows',
      description:
        'The guardrails in force, the risk classes hidden from the tool list and the ' +
        'variable that would restore each, the result size limit, and whether history can ' +
        'be queried. Read this to explain why an expected tool is absent.',
      mimeType: 'application/json',
      // Same argument as the tool list: this changes only when the process restarts.
      cacheHint: { ttlMs: TOOL_LIST_CACHE_MS, cacheScope: 'public' },
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(deploymentState(context.config), null, 2),
        },
      ],
    }),
  );

  registerDomainTemplate(server, context);

  return 2;
}

/**
 * The account's domains, addressable and browsable.
 *
 * This is where the portfolio cache pays for itself twice. It completes the `domainName`
 * variable as it is typed, and it answers `resources/list` — so a client can show the
 * portfolio as a list of things to open rather than requiring the name to be known and typed
 * correctly first. Without it the cache would only ever serve four prompt arguments.
 *
 * Reading one resolves through `getDomain`, which is the same read the equivalent tool does.
 * The tool stays: a resource is for a client browsing, a tool is for a model deciding.
 */
function registerDomainTemplate(server: McpServer, context: ToolContext): void {
  server.registerResource(
    'domain',
    new ResourceTemplate(DOMAIN_RESOURCE_TEMPLATE, {
      list: async () => ({
        resources: (await context.portfolio.list(context.client)).map((domainName) => ({
          uri: `eurodns://domain/${encodeURIComponent(domainName)}`,
          name: domainName,
          mimeType: 'application/json',
        })),
      }),
      complete: {
        domainName: (value) => context.portfolio.complete(context.client, value),
      },
    }),
    {
      title: 'A domain in this account',
      description:
        'The registry record for one domain: expiry, renewal method, nameservers, DNSSEC ' +
        'state, and the contacts attached to it.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      // `Variables` types every value as `string | string[]`. A single `{domainName}`
      // expansion only ever yields the string, but `.flat()` covers both without a branch
      // that no request can reach and no test can honestly exercise.
      const [domainName] = [variables.domainName].flat();

      const response = await context.client.request({
        method: 'GET',
        path: `/domains/${encodeURIComponent(String(domainName))}`,
      });

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    },
  );
}
