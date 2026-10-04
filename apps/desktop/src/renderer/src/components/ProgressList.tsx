import type { Progress, StepStatus } from '../generation';
import { APPROACH_LABEL } from '../types';
import { Spinner } from './Spinner';

/**
 * 생성 진행 목록. 목록은 KRDS info list, 상태는 KRDS badge, 진행 중은 KRDS spinner.
 * aria-live로 단계 변화를 읽어 준다.
 */
const STATUS: Record<StepStatus, { cls: string; label: string }> = {
  waiting: { cls: 'bg-light-gray', label: '대기' },
  running: { cls: 'bg-light-information', label: '진행 중' },
  done: { cls: 'bg-light-success', label: '완료' },
  failed: { cls: 'bg-light-danger', label: '실패' },
};

function Row({ label, status, detail }: { label: string; status: StepStatus; detail?: string }) {
  const s = STATUS[status];
  return (
    <li>
      <span className={`krds-badge ${s.cls}`}>{s.label}</span> {label}
      {detail && <span className="form-hint-invalid"> — {detail}</span>}
      {status === 'running' && <Spinner label={`${label} 진행 중`} />}
    </li>
  );
}

export function ProgressList({ progress }: { progress: Progress }) {
  return (
    <div aria-live="polite">
      <ul className="krds-info-list dash">
        <Row label="유사 답변 검색" status={progress.search} />
        <Row label="민원 분석" status={progress.analyze} />
        <Row label="근거·접근 유형 결정" status={progress.select} />
        <Row label="후보 작성" status={progress.write} />
      </ul>
      {progress.candidates.length > 0 && (
        <ul className="krds-info-list hollow">
          {progress.candidates.map((c) => (
            <Row key={c.approach} label={APPROACH_LABEL[c.approach]} status={c.status} detail={c.reason} />
          ))}
        </ul>
      )}
    </div>
  );
}
