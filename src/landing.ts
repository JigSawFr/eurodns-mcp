import { NATIVE_PROTOCOL_REVISION } from './constants.js';
import { SERVER_DESCRIPTION, SERVER_NAME, SERVER_REPOSITORY } from './server.js';

/**
 * The page served at `/`, for whoever opens this server's address in a browser.
 *
 * **What it deliberately does not say: the version, the tool count, or which risk classes
 * this deployment allows.** `/healthz` already withholds the version, and for a stated
 * reason — it would hand an unauthenticated caller the exact build to look up. A public page
 * on a server that administers DNS is held to the same rule, which is why the pretty parts
 * of a status page are absent here. `landingPage` renders only facts already published
 * elsewhere: the name and description sit in the protected resource metadata, the endpoint
 * is that document's `resource`, and the authentication mode is in every `401`'s
 * `WWW-Authenticate`.
 *
 * Nothing is fetched from a third party. A server that changes DNS records has no business
 * pulling a stylesheet or a font from someone else's origin to render a page about itself,
 * and inlining everything keeps it correct on an isolated network.
 */
export interface LandingOptions {
  /** Canonical public URL, when the operator has set one. */
  publicUrl?: string;
  /** The MCP endpoint path, so the page and the route cannot disagree. */
  endpointPath: string;
  authMode: string;
}

/**
 * Escapes text for HTML.
 *
 * `publicUrl` is operator-supplied configuration, so it is the one value on this page that
 * did not come from the source. Rendering it raw would let a deployment's own configuration
 * inject markup into its own landing page — a small hole, but the only one here, and it
 * costs four replacements to close.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #fbfaf9;
    --panel: #ffffff;
    --ink: #1c1b19;
    --muted: #6b6862;
    --line: #e6e2dc;
    --accent: #b4532a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #171614;
      --panel: #1f1e1b;
      --ink: #ecebe8;
      --muted: #9d9990;
      --line: #302e2a;
      --accent: #e08a5f;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 3rem 1.5rem 4rem;
    background: var(--bg);
    color: var(--ink);
    font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 44rem; margin: 0 auto; }
  .eyebrow {
    font-size: .75rem; letter-spacing: .12em; text-transform: uppercase;
    color: var(--accent); font-weight: 600; margin: 0 0 .6rem;
  }
  h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 .75rem; letter-spacing: -.02em; }
  .lede { font-size: 1.075rem; color: var(--muted); margin: 0 0 2.25rem; }
  h2 {
    font-size: .8rem; letter-spacing: .1em; text-transform: uppercase;
    color: var(--muted); font-weight: 600; margin: 2.5rem 0 .85rem;
  }
  .card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 1.25rem 1.4rem;
  }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .55rem 1.5rem; margin: 0; }
  dt { color: var(--muted); font-size: .9rem; }
  dd { margin: 0; }
  code, .mono {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: .875rem; word-break: break-all;
  }
  ul { margin: 0; padding-left: 1.1rem; }
  li { margin: .3rem 0; }
  a { color: var(--accent); text-underline-offset: 2px; }
  a:hover { text-decoration-thickness: 2px; }
  footer {
    margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid var(--line);
    color: var(--muted); font-size: .875rem;
  }
  @media (max-width: 30rem) {
    body { padding-top: 2rem; }
    h1 { font-size: 1.6rem; }
    dl { grid-template-columns: 1fr; gap: .1rem 0; }
    dt { margin-top: .7rem; }
  }
`;

/** Builds the page. Pure, so a test can assert on the string without starting a server. */
export function landingPage(options: LandingOptions): string {
  const endpoint = options.publicUrl ?? options.endpointPath;
  const rows: Array<[string, string]> = [
    ['Endpoint', `<span class="mono">${escapeHtml(endpoint)}</span>`],
    [
      'Protocol',
      `MCP <span class="mono">${NATIVE_PROTOCOL_REVISION}</span>, and 2025-era clients on the same endpoint`,
    ],
    ['Authentication', `<span class="mono">${escapeHtml(options.authMode)}</span>`],
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${SERVER_NAME}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <p class="eyebrow">Model Context Protocol server</p>
  <h1>${SERVER_NAME}</h1>
  <p class="lede">${escapeHtml(SERVER_DESCRIPTION)}</p>

  <p>This address is an API endpoint, not a web application. It is meant to be reached by an
  MCP client — an assistant, an agent, or anything else that speaks the protocol — rather
  than browsed. There is nothing else to see here.</p>

  <h2>Connecting</h2>
  <div class="card">
    <dl>
${rows.map(([k, v]) => `      <dt>${k}</dt>\n      <dd>${v}</dd>`).join('\n')}
    </dl>
  </div>

  <h2>What it does</h2>
  <ul>
    <li>Exposes the EuroDNS User API as MCP tools — domains, DNS zones, subscriptions, SSL.</li>
    <li>Sorts every operation into a risk class, and a deployment decides which classes it
    permits at all.</li>
    <li>Records each call in a hash-chained audit log, so the history cannot be edited without
    breaking the chain.</li>
  </ul>

  <h2>The project</h2>
  <ul>
    <li><a href="${escapeHtml(SERVER_REPOSITORY)}">Source, documentation and issues on GitHub</a></li>
  </ul>

  <footer>
    An independent open-source project, not affiliated with, endorsed by, or supported by
    EuroDNS. &ldquo;EuroDNS&rdquo; is used only to identify the API this server talks to.
  </footer>
</main>
</body>
</html>
`;
}
