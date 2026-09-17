/**
 * ESLint flat configuration.
 *
 * ESLint 9 reads this file and ignores `.eslintrc.json` unless the deprecated
 * ESLINT_USE_FLAT_CONFIG escape hatch is set, so the old file was silently
 * doing nothing and `npm run lint` failed outright for want of a config.
 *
 * Rules are taken from each plugin's `configs.recommended.rules` - a plain
 * rules map - rather than by spreading a whole preset object. The shape of a
 * preset changes between plugin majors; a rules map does not.
 */

import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['dist/**', 'node_modules/**'] },

  js.configs.recommended,

  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // The automatic JSX runtime is in use, so React needs no import.
      'react/react-in-jsx-scope': 'off',
      // Props are documented by the server schemas these components render.
      'react/prop-types': 'off',
    },
  },

  {
    files: ['*.config.js', 'vite.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
]
