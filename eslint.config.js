import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['node_modules/', 'dist/', '.wrangler/', 'worker-configuration.d.ts']),
  {
    // Workspace rule: never suppress lint per line or per file. With inline config off,
    // an eslint-disable comment has no effect and is reported.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-expect-error': true, 'ts-nocheck': true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      // Everything src/ imports ends up in the public static bundle. The config and all other
      // private data stay on the Worker's side, so src/ may only share types through shared/.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/worker', '**/worker/**'],
              message: 'src/ is public; import shared types from shared/ instead of worker/.',
            },
            {
              group: ['**/stackhush.config*'],
              message: 'src/ is public and the config is private; the UI reads /api/status.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
);
