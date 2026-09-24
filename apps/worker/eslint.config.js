import { baseConfig } from '@parc-auto/config/eslint.base.js';

export default [
  ...baseConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    // Tests : les corps de réponse supertest sont non typés ; les accès sont vérifiés par les assertions.
    files: ['test/**/*.ts', 'src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
];
