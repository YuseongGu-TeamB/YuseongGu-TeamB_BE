import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// .env가 없어도 index.html의 %VITE_API_BASE_URL%(CSP)와 코드가 같은 기본값을 쓰도록
process.env.VITE_API_BASE_URL ??= 'http://localhost:3000';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // VITE_API_BASE_URL 등은 apps/desktop/.env 에서 읽는다
    envDir: __dirname,
    plugins: [react()],
    resolve: {
      // 계약 타입은 packages/contracts 소스를 직접 쓴다(별도 정의 금지)
      alias: { '@minwon/contracts': resolve(__dirname, '../../packages/contracts/src/index.ts') },
    },
    server: { port: 5173, strictPort: true },
  },
});
