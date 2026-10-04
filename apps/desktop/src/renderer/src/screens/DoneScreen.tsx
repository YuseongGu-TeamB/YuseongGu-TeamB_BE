import { useEffect, useRef } from 'react';
import { Notice } from '../components/Notice';
import type { Action } from '../state';

/** 완료 화면: 전송 결과 + 새 민원 입력(상태 초기화) */
export function DoneScreen({ finalAnswer, dispatch }: { finalAnswer: string; dispatch: (a: Action) => void }) {
  const next = useRef<HTMLButtonElement>(null);
  useEffect(() => next.current?.focus(), []);

  return (
    <div className="app-stack">
      <Notice kind="success">전송되었습니다. 이 답변은 이후 답변 작성의 근거로 쓰입니다.</Notice>
      <section aria-labelledby="final-answer">
        <h2 id="final-answer">최종 답변</h2>
        <p className="app-pre">{finalAnswer}</p>
      </section>
      <div className="app-actions">
        <button type="button" className="krds-btn primary large" ref={next} onClick={() => dispatch({ type: 'reset' })}>
          새 민원 입력
        </button>
      </div>
    </div>
  );
}
