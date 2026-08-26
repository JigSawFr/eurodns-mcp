import { describe, expect, it, vi } from 'vitest';
import { parseSecretReference, SecretReferenceError } from '../src/secrets/reference.js';
import {
  OnePasswordConnectClient,
  OnePasswordError,
  connectConfigFrom,
  selectField,
} from '../src/secrets/onepassword.js';
import { resolveEnvSecrets } from '../src/secrets/index.js';

const SECRET = 'the-actual-api-key-value-nobody-should-see';

/** A Connect server holding one vault, one item, one field. */
function connectStub(options: { failWith?: number; missingField?: boolean } = {}) {
  const calls: string[] = [];

  const fetchImpl = vi.fn(async (url: string | URL) => {
    const href = String(url);
    calls.push(href);

    if (options.failWith) {
      return new Response(JSON.stringify({ message: 'nope' }), { status: options.failWith });
    }

    if (href.includes('/v1/vaults?')) {
      return json([{ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Infra' }]);
    }
    if (href.includes('/items?')) {
      return json([{ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'EuroDNS API' }]);
    }
    return json({
      id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
      title: 'EuroDNS API',
      fields: options.missingField
        ? [{ id: 'username', label: 'username', value: 'app-id' }]
        : [
            { id: 'username', label: 'username', value: 'app-id' },
            { id: 'credential', label: 'credential', value: SECRET },
          ],
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('secret references', () => {
  it('parses the three-segment form', () => {
    const reference = parseSecretReference('op://Infra/EuroDNS API/credential');
    expect(reference).toMatchObject({ vault: 'Infra', item: 'EuroDNS API', field: 'credential' });
    expect(reference.section).toBeUndefined();
  });

  it('parses the four-segment form with a section', () => {
    expect(parseSecretReference('op://Infra/EuroDNS API/API/credential')).toMatchObject({
      vault: 'Infra',
      item: 'EuroDNS API',
      section: 'API',
      field: 'credential',
    });
  });

  it('decodes percent-encoded segments', () => {
    expect(parseSecretReference('op://Infra/Euro%2FDNS/credential').item).toBe('Euro/DNS');
  });

  it('rejects a malformed reference rather than guessing', () => {
    expect(() => parseSecretReference('op://Infra/EuroDNS')).toThrow(SecretReferenceError);
    expect(() => parseSecretReference('op://a/b/c/d/e')).toThrow(SecretReferenceError);
    expect(() => parseSecretReference('op://Infra//credential')).toThrow(/empty segment/);
    expect(() => parseSecretReference('https://example.com')).toThrow(SecretReferenceError);
  });
});

describe('Connect configuration', () => {
  it('is absent unless both variables are set', () => {
    expect(connectConfigFrom({} as NodeJS.ProcessEnv)).toBeNull();
    expect(connectConfigFrom({ OP_CONNECT_HOST: 'https://op' } as NodeJS.ProcessEnv)).toBeNull();
    expect(
      connectConfigFrom({
        OP_CONNECT_HOST: 'https://op/',
        OP_CONNECT_TOKEN: 't',
      } as NodeJS.ProcessEnv),
    ).toEqual({ host: 'https://op', token: 't' });
  });
});

describe('resolving against Connect', () => {
  it('walks vault, item, then field', async () => {
    const { fetchImpl, calls } = connectStub();
    const client = new OnePasswordConnectClient({ host: 'https://op', token: 't' }, fetchImpl);

    expect(await client.resolve('op://Infra/EuroDNS API/credential')).toBe(SECRET);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('/v1/vaults?filter=');
    expect(calls[1]).toContain('/items?filter=');
    expect(calls[2]).toMatch(/\/items\/b{26}$/);
  });

  it('sends the Connect token as a bearer credential', async () => {
    const { fetchImpl } = connectStub();
    const client = new OnePasswordConnectClient({ host: 'https://op', token: 'tok' }, fetchImpl);
    await client.resolve('op://Infra/EuroDNS API/credential');

    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]?.[1];
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('skips the lookups when the reference already carries ids', async () => {
    const { fetchImpl, calls } = connectStub();
    const client = new OnePasswordConnectClient({ host: 'https://op', token: 't' }, fetchImpl);

    await client.resolve(`op://${'a'.repeat(26)}/${'b'.repeat(26)}/credential`);
    expect(calls).toHaveLength(1);
  });

  it('resolves each reference only once', async () => {
    const { fetchImpl, calls } = connectStub();
    const client = new OnePasswordConnectClient({ host: 'https://op', token: 't' }, fetchImpl);

    await client.resolve('op://Infra/EuroDNS API/credential');
    await client.resolve('op://Infra/EuroDNS API/credential');
    expect(calls).toHaveLength(3);
  });

  it('names the reference and the step when the token is refused', async () => {
    const { fetchImpl } = connectStub({ failWith: 401 });
    const client = new OnePasswordConnectClient({ host: 'https://op', token: 'bad' }, fetchImpl);

    await expect(client.resolve('op://Infra/EuroDNS API/credential')).rejects.toThrow(
      /refused the token while looking up the vault for op:\/\/Infra/,
    );
  });

  it('reports an unreachable Connect server rather than starting without credentials', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = new OnePasswordConnectClient({ host: 'https://op', token: 't' }, fetchImpl);

    await expect(client.resolve('op://Infra/EuroDNS API/credential')).rejects.toThrow(
      /Could not reach 1Password Connect/,
    );
  });

  it('says which field is missing', async () => {
    const { fetchImpl } = connectStub({ missingField: true });
    const client = new OnePasswordConnectClient({ host: 'https://op', token: 't' }, fetchImpl);

    await expect(client.resolve('op://Infra/EuroDNS API/credential')).rejects.toThrow(
      /no field "credential"/,
    );
  });

  it('matches a field by id when no label matches', () => {
    const value = selectField(
      { fields: [{ id: 'password', value: 'pw' }] },
      { vault: 'v', item: 'i', field: 'password', raw: 'op://v/i/password' },
    );
    expect(value).toBe('pw');
  });

  it('scopes the match to the named section', () => {
    const item = {
      sections: [{ id: 's1', label: 'API' }],
      fields: [
        { label: 'credential', value: 'wrong' },
        { label: 'credential', value: 'right', section: { id: 's1' } },
      ],
    };
    expect(
      selectField(item, {
        vault: 'v',
        item: 'i',
        section: 'API',
        field: 'credential',
        raw: 'op://v/i/API/credential',
      }),
    ).toBe('right');
  });

  it('rejects an empty field value', () => {
    expect(() =>
      selectField(
        { fields: [{ label: 'credential', value: '' }] },
        { vault: 'v', item: 'i', field: 'credential', raw: 'op://v/i/credential' },
      ),
    ).toThrow(OnePasswordError);
  });
});

describe('environment resolution', () => {
  it('leaves an environment without references untouched, and never calls Connect', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const env = { EURODNS_API_KEY: 'literal-value' } as NodeJS.ProcessEnv;

    expect(await resolveEnvSecrets(env, fetchImpl)).toBe(env);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves every EURODNS_* reference, including the MCP token', async () => {
    const { fetchImpl } = connectStub();
    const resolved = await resolveEnvSecrets(
      {
        EURODNS_APP_ID: 'op://Infra/EuroDNS API/username',
        EURODNS_API_KEY: 'op://Infra/EuroDNS API/credential',
        EURODNS_MCP_TOKEN: 'op://Infra/EuroDNS API/credential',
        OP_CONNECT_HOST: 'https://op',
        OP_CONNECT_TOKEN: 't',
      } as NodeJS.ProcessEnv,
      fetchImpl,
    );

    expect(resolved.EURODNS_APP_ID).toBe('app-id');
    expect(resolved.EURODNS_API_KEY).toBe(SECRET);
    expect(resolved.EURODNS_MCP_TOKEN).toBe(SECRET);
  });

  it('ignores references outside the server’s own variables', async () => {
    const { fetchImpl } = connectStub();
    const resolved = await resolveEnvSecrets(
      { SOMETHING_ELSE: 'op://Infra/Other/field' } as NodeJS.ProcessEnv,
      fetchImpl,
    );
    expect(resolved.SOMETHING_ELSE).toBe('op://Infra/Other/field');
  });

  it('refuses to start when a reference is used with no Connect server configured', async () => {
    await expect(
      resolveEnvSecrets({
        EURODNS_API_KEY: 'op://Infra/EuroDNS API/credential',
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/no Connect server is configured/);
  });

  it('never puts a resolved value in an error message', async () => {
    const { fetchImpl } = connectStub({ missingField: true });
    const error = await resolveEnvSecrets(
      {
        EURODNS_API_KEY: 'op://Infra/EuroDNS API/credential',
        OP_CONNECT_HOST: 'https://op',
        OP_CONNECT_TOKEN: 'connect-token-value',
      } as NodeJS.ProcessEnv,
      fetchImpl,
    ).catch((e: unknown) => e as Error);

    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain('connect-token-value');
    expect(error.message).toContain('op://Infra/EuroDNS API/credential');
  });
});
