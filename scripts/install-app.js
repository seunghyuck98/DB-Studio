'use strict';

/**
 * 빌드한 앱을 설치 위치에 반영한다.
 *
 * electron-builder 는 release/ 의 .app 번들을 매번 통째로 지웠다 새로 만든다.
 * 그 번들을 Dock 에 고정해 두면 재빌드마다 참조가 끊겨 다시 고정해야 한다.
 * 그래서 설치본은 고정된 위치에 두고, 재빌드 때는 번들 디렉터리를 그대로 둔 채
 * 안의 내용만 덮어써 Dock 고정이 살아 있게 한다.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP_NAME = 'DB Studio.app';

function fail(message) {
  console.error(`\n실패: ${message}\n`);
  process.exit(1);
}

/** electron-builder 가 만든 .app 을 찾는다 (arm64 / x64 / 기본 출력 위치). */
function findBuiltApp() {
  const release = path.join(ROOT, 'release');
  if (!fs.existsSync(release)) return null;
  const candidates = fs.readdirSync(release)
    .filter((name) => name.startsWith('mac'))
    .map((name) => path.join(release, name, APP_NAME))
    .filter((p) => fs.existsSync(p));
  if (candidates.length === 0) return null;
  // 여러 아키텍처가 있으면 현재 아키텍처를 우선한다.
  const preferred = candidates.find((p) => p.includes(process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'));
  return preferred || candidates[0];
}

function isRunning(bundlePath) {
  const res = spawnSync('pgrep', ['-f', path.join(bundlePath, 'Contents', 'MacOS')], { encoding: 'utf8' });
  return res.status === 0 && res.stdout.trim().length > 0;
}

function main() {
  if (process.platform !== 'darwin') {
    fail('이 스크립트는 macOS 전용입니다. 다른 OS 는 npm run dist 로 설치파일을 만드세요.');
  }

  const source = findBuiltApp();
  if (!source) fail('빌드된 앱을 찾지 못했습니다. 먼저 npm run pack 을 실행하세요.');

  const destDir = process.env.DBSTUDIO_APP_DIR || path.join(os.homedir(), 'Applications');
  const dest = path.join(destDir, APP_NAME);

  if (isRunning(dest)) {
    fail(`${dest} 가 실행 중입니다. 앱을 완전히 종료한 뒤 다시 실행하세요.`);
  }

  fs.mkdirSync(destDir, { recursive: true });

  const existed = fs.existsSync(dest);
  const before = existed ? fs.statSync(dest).ino : null;

  if (existed) {
    // 번들 디렉터리는 그대로 두고 내용만 맞춘다 (Dock 고정 유지의 핵심).
    execFileSync('rsync', ['-a', '--delete', `${source}/`, `${dest}/`], { stdio: 'inherit' });
  } else {
    execFileSync('cp', ['-R', source, dest], { stdio: 'inherit' });
  }

  const after = fs.statSync(dest).ino;

  // Launch Services 가 예전 정보를 들고 있으면 아이콘이 갱신되지 않는다.
  try {
    execFileSync(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', dest],
      { stdio: 'ignore' },
    );
  } catch (_) {
    /* 없거나 실패해도 설치 자체는 끝난 것이다 */
  }

  console.log(`\n설치 위치: ${dest}`);
  if (existed) {
    console.log(before === after
      ? '번들을 그대로 두고 내용만 갱신했습니다 — Dock 고정이 유지됩니다.'
      : '주의: 번들이 새로 만들어졌습니다. Dock 에 다시 고정해야 할 수 있습니다.');
  } else {
    console.log('처음 설치했습니다. Finder 에서 열어 Dock 에 고정해 두면 다음부터는 그대로 유지됩니다.');
  }
}

main();
