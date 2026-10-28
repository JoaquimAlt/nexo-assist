import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // A API (server/index.ts) roda na 8787; o Vite repassa /api para ela.
    proxy: { '/api': 'http://localhost:8787' },
  },
  test: {
    environment: 'node',
    // Testes nunca gravam no banco em disco nem chamam o modelo.
    env: { NEXO_DB_FILE: ':memory:', NEXO_MODEL: 'off' },
  },
});
