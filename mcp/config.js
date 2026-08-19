'use strict';

/**
 * MCP 서버가 쓰는 접속 설정.
 *
 * DB Studio 앱의 접속 정보는 Electron safeStorage 로 암호화돼 있어 앱 밖에서는 풀 수 없다.
 * 그래서 MCP 서버는 자기 설정 파일을 따로 읽는다. 앱을 켜 두지 않아도 동작한다.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FILE = path.join(os.homedir(), '.dbstudio-mcp.json');

function configPath() {
  return process.env.DBSTUDIO_MCP_CONFIG || DEFAULT_FILE;
}

/**
 * 설정을 읽어 접속 목록으로 만든다.
 * 비밀번호는 파일에 직접 적거나 passwordEnv 로 환경변수 이름을 가리킬 수 있다.
 * @returns {{connections: object[], file: string, maxRows: number}}
 */
function load() {
  const file = configPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(
      `설정 파일을 읽을 수 없습니다: ${file}\n`
      + '`npm run mcp:init` 으로 예시 파일을 만든 뒤 접속 정보를 채우세요.',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`설정 파일이 올바른 JSON 이 아닙니다: ${file}\n${e.message}`);
  }

  const list = Array.isArray(parsed.connections) ? parsed.connections : [];
  if (list.length === 0) throw new Error(`설정 파일에 connections 가 없습니다: ${file}`);

  const connections = list.map((c, i) => {
    const name = c.name || `conn${i + 1}`;
    if (!c.kind) throw new Error(`'${name}' 에 kind 가 없습니다 (mysql | mariadb | postgres).`);
    if (!c.host) throw new Error(`'${name}' 에 host 가 없습니다.`);

    let password = c.password ?? '';
    if (c.passwordEnv) {
      if (process.env[c.passwordEnv] === undefined) {
        throw new Error(`'${name}' 의 passwordEnv 로 지정한 환경변수 ${c.passwordEnv} 가 없습니다.`);
      }
      password = process.env[c.passwordEnv];
    }

    return {
      // db 모듈은 id 로 세션을 구분한다. 이름을 그대로 쓴다.
      id: name,
      name,
      kind: c.kind,
      host: c.host,
      port: c.port,
      user: c.user || '',
      password,
      database: c.database || '',
      ssl: !!c.ssl,
      // 조회 전용이 기본이다. 쓰기는 연결마다 명시적으로 열어야 한다.
      readOnly: c.readOnly !== false,
      // 쓰기를 허용해도 자동 커밋으로 두지 않는다 (실수 방지).
      autoCommit: c.autoCommit === true,
    };
  });

  const names = new Set();
  for (const c of connections) {
    if (names.has(c.name)) throw new Error(`접속 이름이 겹칩니다: ${c.name}`);
    names.add(c.name);
  }

  return {
    file,
    connections,
    maxRows: Number(parsed.maxRows) > 0 ? Math.min(Number(parsed.maxRows), 10000) : 200,
  };
}

/**
 * `npm run mcp:init` 이 만드는 예시 설정.
 * 이 상태로도 서버가 뜨도록 비밀번호는 빈 값으로 둔다 (접속은 실제로 쓸 때 열린다).
 * JSON 에는 주석을 쓸 수 없어 _help 로 안내를 남긴다. 모르는 키는 무시된다.
 */
const TEMPLATE = {
  _help: [
    'kind: mysql | mariadb | postgres',
    'password 에 직접 적거나, passwordEnv 로 환경변수 이름을 가리킬 수 있습니다.',
    'readOnly 를 false 로 두면 쓰기가 열립니다. 기본은 조회 전용입니다.',
    'maxRows 는 한 번에 돌려줄 행 수 상한입니다 (최대 10000).',
  ],
  maxRows: 200,
  connections: [
    {
      name: 'local-pg',
      kind: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      password: '',
      database: 'postgres',
      readOnly: true,
    },
    {
      name: 'local-mysql',
      kind: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: '',
      database: '',
      readOnly: true,
    },
  ],
};

module.exports = { load, configPath, DEFAULT_FILE, TEMPLATE };
