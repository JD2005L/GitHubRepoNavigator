import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const unsafeHtml = [
  { property: 'innerHTML', message: 'Build DOM with the h() helper; never insert HTML strings.' },
  { property: 'outerHTML', message: 'Build DOM with the h() helper; never insert HTML strings.' },
  { property: 'insertAdjacentHTML', message: 'Build DOM with the h() helper; never insert HTML strings.' },
];

export default tseslint.config(
  // force-motion.js is a shared drop-in that keeps animations on regardless of reduced-motion settings; it is kept verbatim, so it is not linted.
  { ignores: ['dist/**', 'dist-e2e/**', 'dist-store/**', 'release/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**', 'src/options/force-motion.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['eslint.config.js', 'scripts/*.mjs'] }, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: {
      'no-restricted-properties': ['error', ...unsafeHtml],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.name='eval']", message: 'eval is forbidden in an MV3 extension.' },
        { selector: "NewExpression[callee.name='Function']", message: 'new Function is forbidden in an MV3 extension.' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/shared/log.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['scripts/**', 'e2e/**', 'tests/**', '*.config.*'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**', 'e2e/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // Tests build hostile fixtures on purpose; production code stays restricted.
      'no-restricted-properties': 'off',
    },
  },
  {
    files: ['eslint.config.js', 'scripts/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
