import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: '.',
  server: { port: 5173 },
  resolve: {
    alias: {
      '@slash-ghost/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
});
