// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The CLI layer legitimately throws plain Errors with template messages.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      // `catch (error) { throw new Error(shortMessage(error)) }` is the
      // intended pattern for surfacing viem RPC errors.
      '@typescript-eslint/no-base-to-string': 'off',
      // Records are keyed by ENS label; `noUncheckedIndexedAccess` already
      // makes these accesses explicit.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // Test doubles return a stubbed Response; an `async` arrow that never
      // awaits is the clearest way to express "resolves to this fixture".
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Build config, not application code — it is not in tsconfig.json, so typed
    // linting has no project to resolve against.
    ignores: ['eslint.config.mjs'],
  },
)
