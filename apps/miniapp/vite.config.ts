import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// В разработке запросы к API проксируются на локальный backend; на Vercel API на том же домене.
export default defineConfig({
  plugins: [react()],
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
