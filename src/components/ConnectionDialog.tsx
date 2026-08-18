import { useEffect, useState } from 'react';
import { setState, notify } from '../state/store';
import { saveConnection, connect, message } from '../state/actions';
import type { ConnectionConfig, DbKind } from '../types';

const DEFAULT_PORTS: Record<DbKind, number> = { mysql: 3306, mariadb: 3306, postgres: 5432 };

const KINDS: { value: DbKind; label: string }[] = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'mariadb', label: 'MariaDB' },
  { value: 'postgres', label: 'PostgreSQL' },
];

export default function ConnectionDialog({ connection }: { connection: ConnectionConfig | null }) {
  const isNew = !connection;
  const [form, setForm] = useState<ConnectionConfig>(() => connection ?? {
    id: crypto.randomUUID(),
    name: '',
    kind: 'mysql',
    host: 'localhost',
    port: 3306,
    user: '',
    database: '',
    ssl: false,
    autoCommit: true,
    savePassword: true,
  });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [encryptionOk, setEncryptionOk] = useState(true);

  useEffect(() => {
    window.api.connections.encryptionAvailable().then(setEncryptionOk).catch(() => setEncryptionOk(false));
  }, []);

  const close = () => setState({ dialog: null });
  const set = <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const payload = () => ({ ...form, password: password || undefined });

  const test = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      const r = await window.api.connections.test({
        ...form,
        password: password || (connection?.hasSavedPassword ? undefined : ''),
      });
      setTestResult({ ok: true, text: `접속 성공 · ${r.version}` });
    } catch (e) {
      setTestResult({ ok: false, text: message(e) });
    } finally {
      setBusy(false);
    }
  };

  const save = async (thenConnect: boolean) => {
    if (!form.name.trim()) { notify('error', '접속 이름을 입력하세요.'); return; }
    if (!form.host.trim()) { notify('error', '호스트를 입력하세요.'); return; }
    setBusy(true);
    const saved = await saveConnection(payload());
    setBusy(false);
    if (!saved) return;
    close();
    // 다이얼로그에서 입력한 값(빈 문자열 포함)을 그대로 넘겨 다시 묻지 않는다.
    if (thenConnect) await connect(saved, saved.hasSavedPassword && !password ? undefined : password);
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{isNew ? '새 접속' : '접속 설정'}</h3>

        <div className="form-grid">
          <label>이름</label>
          <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="예: 운영 EMR" autoFocus />

          <label>종류</label>
          <select
            className="select"
            value={form.kind}
            onChange={(e) => {
              const kind = e.target.value as DbKind;
              setForm((f) => ({ ...f, kind, port: DEFAULT_PORTS[kind] }));
            }}
          >
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>

          <label>호스트</label>
          <div className="row">
            <input className="input" value={form.host} onChange={(e) => set('host', e.target.value)} />
            <span className="row-sep">포트</span>
            <input
              className="input narrow"
              type="number"
              value={form.port}
              onChange={(e) => set('port', Number(e.target.value))}
            />
          </div>

          <label>사용자</label>
          <input className="input" value={form.user} onChange={(e) => set('user', e.target.value)} />

          <label>비밀번호</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={connection?.hasSavedPassword ? '저장된 비밀번호 사용 (변경 시 입력)' : ''}
          />

          <label>데이터베이스</label>
          <input
            className="input"
            value={form.database}
            onChange={(e) => set('database', e.target.value)}
            placeholder={form.kind === 'postgres' ? 'postgres' : '(선택)'}
          />

          <label>옵션</label>
          <div className="col">
            <label className="check">
              <input type="checkbox" checked={form.ssl} onChange={(e) => set('ssl', e.target.checked)} />
              SSL 사용
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.autoCommit !== false}
                onChange={(e) => set('autoCommit', e.target.checked)}
              />
              접속 시 자동 커밋
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={!!form.savePassword}
                disabled={!encryptionOk}
                onChange={(e) => set('savePassword', e.target.checked)}
              />
              비밀번호 저장{!encryptionOk && ' (이 환경에서는 사용할 수 없습니다)'}
            </label>
          </div>
        </div>

        {testResult && (
          <div className={`test-result ${testResult.ok ? 'ok' : 'error'}`}>{testResult.text}</div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={() => void test()} disabled={busy}>연결 테스트</button>
          <div className="spacer" />
          <button className="btn" onClick={close} disabled={busy}>취소</button>
          <button className="btn" onClick={() => void save(false)} disabled={busy}>저장</button>
          <button className="btn primary" onClick={() => void save(true)} disabled={busy}>저장 후 접속</button>
        </div>
      </div>
    </div>
  );
}
