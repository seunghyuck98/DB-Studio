import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join('; ');

/**
 * 배포 빌드에만 CSP 메타 태그를 넣는다.
 * Electron 은 dist 를 file:// 로 읽어 응답 헤더가 없으므로 메타 태그가 유일하게 확실한 방법이고,
 * 개발 서버에서는 Vite 가 인라인 스크립트를 주입하므로 넣으면 안 된다.
 */
function cspOnBuild(): Plugin {
  return {
    name: 'csp-on-build',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
    },
  };
}

export default defineConfig({
  plugins: [react(), cspOnBuild()],
  // Electron 이 file:// 로 읽으므로 상대 경로로 빌드한다.
  base: './',
  server: { port: 5273, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome120' },
});
