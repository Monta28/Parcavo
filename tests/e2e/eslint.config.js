import { baseConfig } from '@parc-auto/config/eslint.base.js';

export default baseConfig({ tsconfigRootDir: import.meta.dirname, extraIgnores: ['test-results/**', 'playwright-report/**'] });
