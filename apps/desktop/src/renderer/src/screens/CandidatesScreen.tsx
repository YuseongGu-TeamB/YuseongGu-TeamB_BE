import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { ComplaintPanel } from '../components/ComplaintPanel';
import { EvidenceList } from '../components/EvidenceList';
import { Notice } from '../components/Notice';
import { ProgressList } from '../components/ProgressList';
import { useGeneration } from '../generation';
import type { Action } from '../state';
import { APPROACH_LABEL, type Accepted, type GenerateApiResponse } from '../types';

interface Props {
  complaint: { id: string; content: string };
  result: GenerateApiResponse;
  dispatch: (a: Action) => void;
}

/**
 * 화면 ② 후보 선택. 후보 카드는 KRDS structured list(html/code/structured_list.html).
 * structured list의 c-txt는 3줄로 잘리므로 답변 본문은 card-body 안 일반 문단으로 전문을 보인다.
 */
export function CandidatesScreen({ complaint, result, dispatch }: Props) {
  const gen = useGeneration();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const regenerating = gen.state.phase === 'running';
  const { candidates, is_info_sufficient, insufficient_reason } = result.result;

  useEffect(() => {
    if (gen.state.phase === 'done') dispatch({ type: 'generated', result: gen.state.result });
  }, [gen.state, dispatch]);

  async function regenerate() {
    if (busy || regenerating) return;
    setError(undefined);
    setBusy(true);
    try {
      const accepted = await api<Accepted>('POST', `/complaints/${complaint.id}/generate`);
      gen.follow(accepted.complaint_id, accepted.run_id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function choose(draftId: string, index: number) {
    if (busy) return;
    setError(undefined);
    setBusy(true);
    try {
      await api('PATCH', `/drafts/${draftId}`, { selected: true });
      dispatch({ type: 'selected', draftId, candidate: candidates[index] });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const regenerateButton = (
    <button type="button" className="krds-btn secondary" onClick={() => void regenerate()} disabled={busy || regenerating}>
      후보 다시 만들기
    </button>
  );

  return (
    <div className="app-split">
      <ComplaintPanel content={complaint.content} />

      <div className="app-stack">
        {!is_info_sufficient && <Notice kind="warning">정보가 부족할 수 있습니다: {insufficient_reason ?? '사유 없음'}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        {gen.state.phase === 'error' && <Notice kind="error">{gen.state.message}</Notice>}
        {gen.state.phase === 'running' && <ProgressList progress={gen.state.progress} />}

        {candidates.length === 0 && !regenerating && (
          <Notice kind="error" action={regenerateButton}>
            후보를 만들지 못했습니다.
          </Notice>
        )}

        {!regenerating && (candidates.length > 0 || result.failed.length > 0) && (
          <ul className="krds-structured-list">
            {candidates.map((c, i) => {
              const draft = result.drafts[i];
              const titleId = `cand-${draft.draft_id}`;
              return (
                <li key={draft.draft_id} className="structured-item">
                  <div className="in">
                    <div className="card-top">
                      <span className="krds-badge bg-light-primary">{APPROACH_LABEL[c.approach]}</span>
                    </div>
                    <div className="card-body">
                      <div className="c-text">
                        <p className="c-tit" id={titleId}>
                          <span className="span">후보 {i + 1}</span>
                        </p>
                      </div>
                      <p className="app-pre">{c.answer}</p>

                      <h3>근거</h3>
                      <EvidenceList sources={c.used_sources} evidence={result.evidence} />

                      {c.assumptions.length > 0 && (
                        <>
                          <h3>
                            <span className="krds-badge bg-light-warning">검토 필요</span> 근거 없이 들어간 내용
                          </h3>
                          <ul className="krds-info-list dash">
                            {c.assumptions.map((a) => (
                              <li key={a}>{a}</li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                    <div className="card-btn">
                      <button
                        type="button"
                        className="krds-btn primary"
                        aria-describedby={titleId}
                        disabled={busy}
                        onClick={() => void choose(draft.draft_id, i)}
                      >
                        이 답변으로 수정하기
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
            {result.failed.map((f) => (
              <li key={`failed-${f.approach}`} className="structured-item">
                <div className="in">
                  <div className="card-top">
                    <span className="krds-badge bg-disabled">{APPROACH_LABEL[f.approach]}</span>
                  </div>
                  <div className="card-body">
                    <p className="form-hint">생성 실패: {f.reason}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {candidates.length > 0 && <div className="app-actions">{regenerateButton}</div>}
      </div>
    </div>
  );
}
