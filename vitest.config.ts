import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
