import type { Candidate } from '@minwon/contracts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { ComplaintPanel } from '../components/ComplaintPanel';
import { ConfirmModal } from '../components/ConfirmModal';
import { EvidenceList } from '../components/EvidenceList';
import { Notice } from '../components/Notice';
import { Spinner } from '../components/Spinner';
import { COMPLAINT_MAX_CHARS } from '../config';
import type { Action } from '../state';
import { APPROACH_LABEL, type GenerateApiResponse } from '../types';

type Save = 'idle' | 'saving' | 'saved' | 'error';
type Send = 'idle' | 'approving' | 'sending' | 'approved-send-failed';

const AUTOSAVE_MS = 1000;

interface Props {
  complaint: { id: string; content: string };
  selected: { draftId: string; candidate: Candidate };
  evidence: GenerateApiResponse['evidence'];
  dispatch: (a: Action) => void;
}

/** 화면 ③ 수정·전송. 입력을 멈추고 1초 뒤 자동 저장, 전송은 확인 모달 → approve → send */
export function EditScreen({ complaint, selected, evidence, dispatch }: Props) {
  const id = useId();
  const [text, setText] = useState(selected.candidate.answer);
  const [save, setSave] = useState<Save>('idle');
  const [send, setSend] = useState<Send>('idle');
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const savedText = useRef(selected.candidate.answer); // 서버에 반영된 내용
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const approved = send === 'approved-send-failed' || send === 'sending';
  const working = send === 'approving' || send === 'sending';

  /** 수정본 저장. 원래 답변과 같으면 수정본을 지운다(null) */
  const persist = useCallback(
    async (value: string) => {
      if (value === savedText.current) return;
      setSave('saving');
      const edited = value.trim() === '' || value === selected.candidate.answer ? null : value;
      try {
        await api('PATCH', `/drafts/${selected.draftId}`, { edited_answer: edited });
        savedText.current = value;
        setSave('saved');
      } catch (e) {
        setSave('error');
        throw e;
      }
    },
    [selected],
  );

  useEffect(() => {
    if (approved || working) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(text).catch((e) => setError(errorMessage(e))), AUTOSAVE_MS);
    return () => clearTimeout(timer.current);
  }, [text, persist, approved, working]);

  async function chooseOther() {
    setError(undefined);
    clearTimeout(timer.current);
    try {
      await persist(text);
      await api('PATCH', `/drafts/${selected.draftId}`, { selected: false });
      dispatch({ type: 'go', screen: 'candidates' });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function submit() {
    setConfirming(false);
    setError(undefined);
    clearTimeout(timer.current);
    try {
      if (!approved) {
        setSend('approving');
        await persist(text); // 입력 중이던 내용까지 저장한 뒤 승인
        await api('POST', `/complaints/${complaint.id}/approve`);
      }
    } catch (e) {
      setSend('idle');
      setError(errorMessage(e));
      return;
    }
    try {
      setSend('sending');
      await api('POST', `/complaints/${complaint.id}/send`);
      dispatch({ type: 'sent', finalAnswer: text.trim() === '' ? selected.candidate.answer : text });
    } catch (e) {
      setSend('approved-send-failed');
      setError(errorMessage(e));
    }
  }

  const saveHint =
    save === 'saving' ? '저장 중…' : save === 'saved' ? '저장됨' : save === 'error' ? '저장하지 못했습니다' : '';

  return (
    <div className="app-split">
      <div className="app-stack">
        <ComplaintPanel content={complaint.content} />
        <section aria-labelledby={`${id}-ev`}>
          <h2 id={`${id}-ev`}>근거</h2>
          <EvidenceList sources={selected.candidate.used_sources} evidence={evidence} />
        </section>
      </div>

      <div className="app-stack">
        <div>
          <span className="krds-badge bg-light-primary">{APPROACH_LABEL[selected.candidate.approach]}</span>
        </div>

        <div className="form-group">
          <div className="form-tit">
            <label htmlFor={`${id}-answer`}>답변 수정</label>
          </div>
          <div className="form-conts">
            <div className="textarea-wrap">
              <textarea
                id={`${id}-answer`}
                className="krds-input"
                value={text}
                rows={12}
                maxLength={COMPLAINT_MAX_CHARS}
                disabled={approved || working}
                onChange={(e) => {
                  setText(e.target.value);
                  setSave('idle');
                }}
                aria-describedby={`${id}-save`}
              />
              <p className="textarea-count">
                <span className="count-now">{text.length.toLocaleString()}</span>
                <span className="count-total">/{COMPLAINT_MAX_CHARS.toLocaleString()}</span>
              </p>
            </div>
            <p
              id={`${id}-save`}
              className={save === 'error' ? 'form-hint-invalid' : save === 'saved' ? 'form-hint-success' : 'form-hint'}
              aria-live="polite"
            >
              {saveHint}
            </p>
          </div>
        </div>

        {selected.candidate.assumptions.length > 0 && (
          <section aria-label="검토 필요">
            <h3>
              <span className="krds-badge bg-light-warning">검토 필요</span> 근거 없이 들어간 내용
            </h3>
            <ul className="krds-info-list dash">
              {selected.candidate.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </section>
        )}

        {send === 'approved-send-failed' && (
          <Notice
            kind="warning"
            action={
              <button type="button" className="krds-btn medium secondary" onClick={() => void submit()}>
                전송 다시 시도
              </button>
            }
          >
            승인됨, 전송 실패: {error}
          </Notice>
        )}
        {error && send !== 'approved-send-failed' && <Notice kind="error">{error}</Notice>}

        <div className="app-actions" aria-live="polite">
          <button type="button" className="krds-btn secondary" onClick={() => void chooseOther()} disabled={approved || working}>
            다른 후보 고르기
          </button>
          <button
            type="button"
            className="krds-btn primary"
            onClick={() => setConfirming(true)}
            disabled={approved || working || text.trim() === ''}
          >
            전송
          </button>
          {working && <Spinner label={send === 'approving' ? '승인 중' : '전송 중'} />}
        </div>
      </div>

      <ConfirmModal
        open={confirming}
        title="답변 전송"
        confirmLabel="승인하고 전송"
        cancelLabel="취소"
        onConfirm={() => void submit()}
        onCancel={() => setConfirming(false)}
      >
        이 답변을 승인하고 전송합니다. 전송된 답변은 이후 답변 작성의 근거로 쓰입니다.
      </ConfirmModal>
    </div>
  );
}
