// One lint setup for the whole project: npm run lint
const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');

const reactRules = {
  plugins: { react, 'react-hooks': reactHooks },
  settings: { react: { version: 'detect' } },
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  rules: {
    ...react.configs.recommended.rules,
    ...react.configs['jsx-runtime'].rules,
    'react/prop-types': 'off',
    'react/no-unescaped-entities': 'off',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
};

module.exports = [
  {
    ignores: [
      '**/node_modules/**', '**/dist/**', '**/build/**', '**/.expo/**',
      'mobile/android/**', 'mobile/ios/**', 'e2e/screenshots/**',
    ],
  },
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Node: server, test runner, build scripts
  {
    files: ['server/server.js', 'e2e/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    files: ['**/scripts/**/*.{js,mjs}', 'mobile/test/**/*.mjs', 'extension/vite.config.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
  // e2e scripts also contain code that runs inside the browser (page.evaluate)
  { files: ['e2e/**/*.js'], languageOptions: { globals: { ...globals.browser } } },

  // Browser pages served by the PC server
  { files: ['server/public/**/*.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser } } },

  // Chrome extension: content scripts + service worker (plain scripts), popup (React)
  {
    files: ['extension/public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.serviceworker, chrome: 'readonly' } },
  },
  {
    files: ['extension/src/**/*.{js,jsx}'],
    ...reactRules,
    languageOptions: { ...reactRules.languageOptions, sourceType: 'module', globals: { ...globals.browser, chrome: 'readonly' } },
  },

  // React Native app
  {
    files: ['mobile/**/*.{js,jsx}'],
    ignores: ['mobile/scripts/**'],
    ...reactRules,
    languageOptions: { ...reactRules.languageOptions, sourceType: 'module', globals: { ...globals.browser, __DEV__: 'readonly' } },
  },
];
