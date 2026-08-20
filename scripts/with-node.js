/*
 * npm 스크립트가 너무 낮은 Node 에서 시작됐으면, .nvmrc 에 적힌 버전으로 바꿔 다시 실행한다.
 *
 * Vite 5 는 Node 18+ 가 필요한데, nvm 기본값이 그보다 낮으면
 * "crypto$2.getRandomValues is not a function" 처럼 원인을 짐작하기 어려운 오류가 난다.
 * 매번 `nvm use` 를 기억하는 대신 여기서 알아서 맞춰 준다.
 *
 * 이 파일 자체는 오래된 Node 에서 실행되므로 옛 문법만 쓴다.
 *
 *   node scripts/with-node.js vite build
 */
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var spawn = require('child_process').spawnSync;

var ROOT = path.join(__dirname, '..');
var args = process.argv.slice(2);

if (!args.length) {
  console.error('실행할 명령이 없습니다. 예: node scripts/with-node.js vite build');
  process.exit(2);
}

/** .nvmrc 에 적어 둔 버전 (예: "20.20.2"). 없으면 null. */
function pinnedVersion() {
  try {
    var raw = fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
    if (/^\d+(\.\d+)*$/.test(raw)) return raw;
  } catch (e) { /* .nvmrc 가 없으면 major 기본값만 쓴다 */ }
  return null;
}

var pinned = pinnedVersion();
var need = pinned ? parseInt(pinned.split('.')[0], 10) : 20;
var current = parseInt(process.versions.node.split('.')[0], 10);

/** .nvmrc 의 버전을 먼저 찾고, 없으면 조건을 만족하는 가장 높은 버전을 고른다. */
function findNode() {
  var dirs = [];
  var nvm = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  dirs.push(path.join(nvm, 'versions', 'node'));
  dirs.push(path.join(os.homedir(), '.local', 'share', 'fnm', 'node-versions'));
  dirs.push(path.join(os.homedir(), '.volta', 'tools', 'image', 'node'));

  var best = null;
  for (var i = 0; i < dirs.length; i++) {
    var base = dirs[i];
    var entries;
    try { entries = fs.readdirSync(base); } catch (e) { continue; }
    for (var j = 0; j < entries.length; j++) {
      var name = entries[j];
      var major = parseInt(String(name).replace(/^v/, '').split('.')[0], 10);
      if (!(major >= need)) continue;
      // fnm 은 <버전>/installation/bin 아래에 둔다.
      var candidates = [path.join(base, name, 'bin'), path.join(base, name, 'installation', 'bin')];
      for (var k = 0; k < candidates.length; k++) {
        var bin = candidates[k];
        if (!fs.existsSync(path.join(bin, 'node'))) continue;
        var found = { version: String(name).replace(/^v/, ''), bin: bin };
        // .nvmrc 에 적힌 버전이 깔려 있으면 그걸 그대로 쓴다.
        if (pinned && found.version === pinned) return found;
        if (!best || compare(found.version, best.version) > 0) best = found;
      }
    }
  }

  // 버전 관리자를 쓰지 않는 설치본도 본다.
  var plain = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (var m = 0; m < plain.length; m++) {
    if (best) break;
    var exe = path.join(plain[m], 'node');
    if (!fs.existsSync(exe)) continue;
    var out = spawn(exe, ['-v'], { encoding: 'utf8' });
    if (out.status !== 0 || !out.stdout) continue;
    var v = out.stdout.trim();
    if (parseInt(v.replace(/^v/, '').split('.')[0], 10) >= need) best = { version: v, bin: plain[m] };
  }
  return best;
}

/** v20.11.1 처럼 생긴 두 버전을 숫자로 비교한다. */
function compare(a, b) {
  var x = String(a).replace(/^v/, '').split('.');
  var y = String(b).replace(/^v/, '').split('.');
  for (var i = 0; i < 3; i++) {
    var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

var env = Object.assign({}, process.env);

/** 자식 프로세스가 이 디렉터리의 node 를 먼저 찾게 한다. */
function useBin(bin) {
  var parts = String(env.PATH || '').split(path.delimiter).filter(function (p) {
    // 다른 버전이 앞에 남아 있으면 그쪽이 먼저 잡히므로 걸러 낸다.
    return p && p !== bin && !/[\/\\](\.nvm|\.fnm|fnm|\.volta)[\/\\]/.test(p);
  });
  parts.unshift(bin);
  env.PATH = parts.join(path.delimiter);
  // npm 이 자기를 실행한 node 를 물려주려고 심어 두는 값들을 지운다.
  delete env.npm_node_execpath;
  delete env.NODE;
}

if (current >= need) {
  // 이미 조건을 만족하는 Node 로 돌고 있다. 자식도 같은 Node 를 쓰게 맞춰 준다
  // (PATH 앞쪽에 낮은 버전이 남아 있는 경우가 있다).
  useBin(path.dirname(process.execPath));
} else {
  var picked = findNode();
  if (!picked) {
    console.error('');
    console.error('  Node ' + need + ' 이상이 필요한데 현재 ' + process.version + ' 로 실행되고 있습니다.');
    console.error('  (Vite 가 Node ' + need + '+ 를 요구합니다.)');
    console.error('');
    console.error('  nvm 을 쓰신다면:');
    console.error('');
    console.error('    nvm install        # .nvmrc 의 버전을 설치');
    console.error('    nvm use            # 이 터미널에서 사용');
    console.error('');
    console.error('  매번 바꾸기 번거로우면 기본값으로 지정하세요:');
    console.error('');
    console.error('    nvm alias default ' + need);
    console.error('');
    process.exit(1);
  }
  console.log('[with-node] ' + process.version + ' → v' + picked.version + ' 로 바꿔 실행합니다.');
  useBin(picked.bin);
}

var res = spawn(args.join(' '), {
  cwd: process.cwd(),
  env: env,
  stdio: 'inherit',
  shell: true,
});

if (res.error) {
  console.error(res.error.message);
  process.exit(1);
}
process.exit(res.status === null ? 1 : res.status);
