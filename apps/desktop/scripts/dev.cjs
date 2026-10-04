// VSCode 등에서 물려받은 ELECTRON_RUN_AS_NODE=1이 있으면 Electron이 Node로 떠서 앱이 열리지 않는다.
// 그 변수만 지우고 electron-vite dev를 실행한다.
const { spawn } = require('node:child_process');
const path = require('node:path');

delete process.env.ELECTRON_RUN_AS_NODE;
const pkgDir = path.dirname(require.resolve('electron-vite/package.json'));
const bin = path.join(pkgDir, require('electron-vite/package.json').bin['electron-vite']);
spawn(process.execPath, [bin, 'dev', ...process.argv.slice(2)], { stdio: 'inherit' }).on('exit', (code) =>
  process.exit(code ?? 0),
);
