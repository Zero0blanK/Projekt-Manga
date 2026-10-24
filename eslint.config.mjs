import js from '@eslint/js';
import eslintPluginPrettier from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';

export default tseslint.config(
  // Depth-independent on purpose. Flat-config `ignores` are resolved relative to this
  // file's directory, so bare "dist"/".next" would only match <repo root>/dist and leave
  // each workspace's own compiled output lintable.
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/out/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      // electron-builder's output (apps/desktop/release/) — staged node_modules, a copied
      // Node runtime, and whatever installed-extension bundles a packaged test run
      // downloaded. All generated, none of it hand-written. `.gitignore` already excludes
      // it from commits, but ESLint's flat config doesn't read .gitignore on its own.
      '**/release/**',
      // Downloaded source bundles for installed extensions (server data dir, and its
      // equivalent under a packaged build's resources/) — untrusted, minified third-party
      // code fetched at runtime, not part of this repo. Same .gitignore-doesn't-reach-
      // ESLint gap as above.
      '**/data/installed-extensions/**',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  // Next's lint rules, scoped to apps/web because only it is a Next app. Registering the
  // plugin is also what lets `@next/next/...` disable comments there resolve to known rules.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    // Without this the plugin looks for a pages/ directory at the repo root and warns
    // that it cannot find one. apps/web is the Next project, and it is App Router only.
    settings: { next: { rootDir: 'apps/web' } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // Pages Router only — there is no pages/ directory to validate links against.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
  // react-refresh/only-export-components asks a file to export components and nothing
  // else. Two places in this app cannot satisfy that, and neither is a defect:
  //
  // - App Router route files. `metadata`, `viewport` and `generateMetadata` are exports
  //   Next.js requires next to the default component; there is nowhere else to put them.
  // - components/ui/** is vendored shadcn/ui, where a component ships alongside its
  //   `cva` variants by design. Rewriting generated files to satisfy a dev-server hint
  //   would just be undone by the next `npx shadcn add`.
  {
    files: ['apps/web/src/app/**/*.tsx', 'apps/web/src/components/ui/**/*.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  eslintPluginPrettier,
);
