import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  const parsedUiPort = Number.parseInt(env.MIDFORM_UI_PORT || '5177', 10);
  const uiPort = Number.isInteger(parsedUiPort) ? parsedUiPort : 5177;
  const apiTarget = env.VITE_MIDFORM_API_TARGET || `http://localhost:${env.PORT || '3016'}`;

  return {
    envDir: repoRoot,
    plugins: [react()],
    server: {
      port: uiPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true
        }
      }
    }
  };
});
