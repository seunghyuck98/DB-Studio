import { useState } from 'react';
import { setState } from '../state/store';
import { connect } from '../state/actions';
import type { ConnectionConfig } from '../types';

/** 비밀번호를 저장하지 않은 접속에 대해 접속 시점에 입력받는다. */
export default function PasswordDialog({ connection }: { connection: ConnectionConfig }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => setState({ dialog: null });

  const submit = async () => {
    setBusy(true);
    setState({ dialog: null });
    await connect(connection, password);
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal narrow" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{connection.name} 접속</h3>
        <p className="modal-desc">{connection.user}@{connection.host}:{connection.port}</p>
        <input
          className="input"
          type="password"
          placeholder="비밀번호"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
        />
        <div className="modal-actions">
          <div className="spacer" />
          <button className="btn" onClick={close} disabled={busy}>취소</button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>접속</button>
        </div>
      </div>
    </div>
  );
}
