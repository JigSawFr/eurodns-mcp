import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'src/generated/**', 'coverage/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      // Both projects, named explicitly. Type information is what makes the rules below
      // work at all — without it the plugin runs syntax-only and silently drops the whole
      // class worth having here, since this server is async end to end and an unawaited
      // promise is the failure mode that does not announce itself.
      //
      // Naming tsconfig.tests.json matters as much as tsconfig.json: the build config
      // excludes tests, so leaving it out would let them escape type-aware linting exactly
      // as they escaped `tsc` before it was added.
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        project: ['./tsconfig.json', './tsconfig.tests.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // The type-aware set, chosen rather than enabling recommendedTypeChecked wholesale:
      // most of that preset is style, and these three are the ones that catch defects.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // `require-await` was tried and dropped: it flagged five sites, all of them functions
      // whose `async` is demanded by the signature they implement — an OAuthTokenVerifier, a
      // tool handler, three `fetch` doubles — and no defect among them. A rule that cannot
      // see the contract a function satisfies is a rule that trains people to ignore it.
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
];
