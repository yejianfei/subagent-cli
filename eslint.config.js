const js = require('@eslint/js')
const tseslint = require('@typescript-eslint/eslint-plugin')
const tsparser = require('@typescript-eslint/parser')
const globals = require('globals')

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.{js,cjs,mjs,ts}'],
    plugins: {
      '@typescript-eslint': tseslint,
    },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.es2017,
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        'args': 'all',
        'argsIgnorePattern': '^_',
        'caughtErrors': 'all',
        'caughtErrorsIgnorePattern': '^_',
        'destructuredArrayIgnorePattern': '^_',
        'varsIgnorePattern': '^_',
        'ignoreRestSiblings': true,
      }],
      'no-control-regex': 'off',
      'quotes': ['error', 'single'],
      'semi': ['error', 'never'],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'test/', 'webpack.config.js'],
  },
]
