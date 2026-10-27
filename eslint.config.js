import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'dist-test/**', 'src/generated/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Los nombres de los campos de la API van en snake_case; renombrarlos
      // obligaría a aprender dos vocabularios.
      '@typescript-eslint/naming-convention': 'off',
      '@typescript-eslint/no-empty-object-type': ['error', { allowWithName: '.*' }],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `describe()` e `it()` de `node:test` devuelven una promesa que el
      // corredor gestiona; encadenarla a mano no aporta nada.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'examples/**/*.mjs', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly' },
    },
  },
);
