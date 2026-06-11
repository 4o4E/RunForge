import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // 前端开发代理默认指向本地后端，也允许部署/联调时通过环境变量覆盖。
  const backendOrigin = env.VITE_BACKEND_ORIGIN ?? env.BACKEND_ORIGIN ?? 'http://localhost:8080';
  const backendProxy: ProxyOptions = {
    target: backendOrigin,
    changeOrigin: true,
  };

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 3000,
      proxy: {
        '/api': backendProxy,
        '/health': backendProxy,
        '/ws': { ...backendProxy, ws: true },
      },
    },
  };
});
