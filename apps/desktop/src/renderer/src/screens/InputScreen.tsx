import { useEffect, useId, useState } from 'react';
import { api, errorMessage } from '../api';
import { Notice } from '../components/Notice';
import { ProgressList } from '../components/ProgressList';
import { COMPLAINT_MAX_CHARS } from '../config';
import { useGeneration } from '../generation';
import type { Action } from '../state';
import type { Accepted } from '../types';

/** 화면 ① 민원 입력 → POST /complaints/quick → SSE 진행 → done이면 화면 ② */
export function InputScreen({ dispatch, complaintId }: { dispatch: (a: Action) => void; complaintId?: string }) {
  const id = useId();
  const [content, setContent] = useState('');
  const [starting, setStarting] = useState(false);
  const gen = useGeneration();
  const busy = starting || gen.state.phase === 'running';
  const trimmed = content.trim();
  const over = content.length > COMPLAINT_MAX_CHARS;

  useEffect(() => {
    if (gen.state.phase === 'done') dispatch({ type: 'generated', result: gen.state.result });
  }, [gen.state, dispatch]);

  async function start() {
    if (busy || !trimmed || over) return;
    setStarting(true);
    try {
      // 이미 접수됐는데 생성만 실패했다면 같은 민원으로 다시 생성한다(중복 접수 방지)
      const existing = gen.state.phase === 'error' ? gen.state.complaintId ?? complaintId : undefined;
      const accepted = existing
        ? await api<Accepted>('POST', `/complaints/${existing}/generate`)
        : await api<Accepted>('POST', '/complaints/quick', { content: trimmed });
      dispatch({ type: 'complaint', id: accepted.complaint_id, content: trimmed });
      gen.follow(accepted.complaint_id, accepted.run_id);
    } catch (e) {
      gen.setError(errorMessage(e), gen.state.phase === 'error' ? gen.state.complaintId : undefined);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="app-stack">
      <div className="form-group">
        <div className="form-tit">
          <label htmlFor={`${id}-complaint`}>민원 원문</label>
        </div>
        <div className="form-conts">
          <div className="textarea-wrap">
            <textarea
              id={`${id}-complaint`}
              className="krds-input"
              placeholder="민원 원문을 붙여넣으세요."
              value={content}
              maxLength={COMPLAINT_MAX_CHARS}
              rows={14}
              disabled={busy}
              onChange={(e) => setContent(e.target.value)}
              aria-describedby={`${id}-count`}
            />
            <p className="textarea-count" id={`${id}-count`}>
              <span className="count-now">{content.length.toLocaleString()}</span>
              <span className="count-total">/{COMPLAINT_MAX_CHARS.toLocaleString()}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="app-actions">
        <button type="button" className="krds-btn primary large" onClick={() => void start()} disabled={busy || !trimmed || over}>
          답변 후보 만들기
        </button>
      </div>

      {gen.state.phase === 'running' && <ProgressList progress={gen.state.progress} />}
      {gen.state.phase === 'error' && (
        <>
          {gen.state.progress && <ProgressList progress={gen.state.progress} />}
          <Notice
            kind="error"
            action={
              <button type="button" className="krds-btn medium secondary" onClick={() => void start()} disabled={busy}>
                다시 시도
              </button>
            }
          >
            {gen.state.message}
          </Notice>
        </>
      )}
    </div>
  );
}
