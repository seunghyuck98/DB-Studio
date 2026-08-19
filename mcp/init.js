#!/usr/bin/env node
'use strict';

/** MCP 서버 설정 파일의 예시를 만든다. 이미 있으면 덮어쓰지 않는다. */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const file = config.configPath();

if (fs.existsSync(file)) {
  console.log(`이미 있습니다: ${file}`);
  console.log('그대로 두었습니다. 내용을 고쳐서 쓰세요.');
  process.exit(0);
}

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(config.TEMPLATE, null, 2)}\n`, { mode: 0o600 });
// 비밀번호가 들어갈 수 있는 파일이라 본인만 읽도록 권한을 좁힌다.
fs.chmodSync(file, 0o600);

console.log(`만들었습니다: ${file}  (권한 600)`);
console.log('\n접속 정보를 채운 뒤, Claude Code 에 등록하세요:\n');
console.log(`  claude mcp add dbstudio -- node ${path.join(__dirname, 'server.js')}\n`);
console.log('비밀번호는 파일에 직접 적거나, passwordEnv 로 환경변수 이름을 가리킬 수 있습니다.');
console.log('접속은 기본이 조회 전용입니다. 쓰기가 필요하면 "readOnly": false 를 넣으세요.');
