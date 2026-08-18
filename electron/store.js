'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

/**
 * 접속 정보를 userData 폴더의 JSON 파일에 보관한다.
 * 비밀번호는 OS 키체인 기반 safeStorage 로 암호화해서 저장하고,
 * 암호화를 쓸 수 없는 환경에서는 저장하지 않는다.
 */
function filePath() {
  return path.join(app.getPath('userData'), 'connections.json');
}

function readAll() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeAll(list) {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(list, null, 2), 'utf8');
}

function encrypt(password) {
  if (!password) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(password).toString('base64');
}

function decrypt(blob) {
  if (!blob) return '';
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch (_) {
    return '';
  }
}

/** UI 로 넘길 때는 암호를 뺀 형태로 반환한다. */
function toPublic(c) {
  const { passwordEnc, ...rest } = c;
  return { ...rest, hasSavedPassword: !!passwordEnc };
}

function list() {
  return readAll().map(toPublic);
}

/** 실제 접속에 쓸 설정 (복호화된 비밀번호 포함). */
function resolve(id, overridePassword) {
  const found = readAll().find((c) => c.id === id);
  if (!found) throw new Error('저장된 접속 정보를 찾을 수 없습니다.');
  const { passwordEnc, ...rest } = found;
  // 빈 문자열도 유효한 비밀번호이므로 undefined 일 때만 저장된 값을 쓴다.
  return { ...rest, password: overridePassword !== undefined ? overridePassword : decrypt(passwordEnc) };
}

function save(conn) {
  const list = readAll();
  const idx = list.findIndex((c) => c.id === conn.id);
  const record = {
    id: conn.id,
    name: conn.name,
    kind: conn.kind,
    host: conn.host,
    port: conn.port,
    user: conn.user,
    database: conn.database || '',
    ssl: !!conn.ssl,
    autoCommit: conn.autoCommit !== false,
    color: conn.color || null,
  };
  if (conn.savePassword && conn.password) {
    record.passwordEnc = encrypt(conn.password);
  } else if (conn.savePassword && idx >= 0) {
    record.passwordEnc = list[idx].passwordEnc; // 비밀번호를 다시 입력하지 않은 경우 유지
  }
  record.savePassword = !!record.passwordEnc;

  if (idx >= 0) list[idx] = record; else list.push(record);
  writeAll(list);
  return toPublic(record);
}

function remove(id) {
  writeAll(readAll().filter((c) => c.id !== id));
  return true;
}

module.exports = { list, save, remove, resolve, encryptionAvailable: () => safeStorage.isEncryptionAvailable() };
