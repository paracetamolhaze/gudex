import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// В разработке запросы к API проксируются на локальный backend; на Vercel API на том же домене.
export default defineConfig({
  plugins: [react()],
  // The version shown in the profile comes from package.json.
  define: { __APP_VERSION__: JSON.stringify(version) },
  // В монорепозитории React должен быть в одном экземпляре, иначе хуки ломаются.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: 5174,
    host: true,
    proxy: {
      '/v1': 'http://localhost:4100',
      '/health': 'http://localhost:4100',
    },
  },
  build: { target: 'es2020', sourcemap: false },
});
