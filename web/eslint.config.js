import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // A leading underscore is the conventional "deliberately unused" marker
      // (kept for a stable signature, or documenting an argument we ignore).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Context modules intentionally export a Provider component alongside its
    // consumer hook. Splitting them into separate files to satisfy this rule
    // would churn every import site for a dev-only Fast Refresh nicety, so the
    // trade is made deliberately here rather than with scattered inline disables.
    files: ['src/context/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
