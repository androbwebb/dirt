import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/**/*.ts'], languageOptions: { globals: globals.browser } },
  { files: ['electron/**/*.js', 'scripts/**/*.js'], languageOptions: { globals: globals.node } },
  { files: ['electron/**/*.cjs', 'scripts/**/*.cjs'], languageOptions: { globals: globals.node, sourceType: 'commonjs' }, rules: { '@typescript-eslint/no-require-imports': 'off' } },
);
