import { useEffect, useReducer, useRef } from 'react';
import { HealthBadges } from './components/HealthBadges';
import { StepIndicator } from './components/StepIndicator';
import { CandidatesScreen } from './screens/CandidatesScreen';
import { DoneScreen } from './screens/DoneScreen';
import { EditScreen } from './screens/EditScreen';
import { InputScreen } from './screens/InputScreen';
import { initialState, reducer, type Screen } from './state';

const STEP_OF: Record<Screen, 1 | 2 | 3 | 'done'> = { input: 1, candidates: 2, edit: 3, done: 'done' };
const TITLE_OF: Record<Screen, string> = {
  input: '민원 입력',
  candidates: '후보 선택',
  edit: '수정·전송',
  done: '전송 완료',
};

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const heading = useRef<HTMLHeadingElement>(null);

  // 화면이 바뀌면 제목으로 포커스를 옮겨 키보드·화면낭독 사용자가 새 화면을 알 수 있게 한다
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (state.screen !== 'done') heading.current?.focus();
  }, [state.screen]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="page-title-wrap between">
          <h1 className="h-tit" ref={heading} tabIndex={-1}>
            {TITLE_OF[state.screen]}
          </h1>
        </div>
        <StepIndicator current={STEP_OF[state.screen]} />
        <HealthBadges />
      </header>
      <main className="app-main">
        {state.screen === 'input' && <InputScreen dispatch={dispatch} complaintId={state.complaint?.id} />}
        {state.screen === 'candidates' && state.complaint && state.result && (
          <CandidatesScreen complaint={state.complaint} result={state.result} dispatch={dispatch} />
        )}
        {state.screen === 'edit' && state.complaint && state.selected && state.result && (
          <EditScreen
            key={state.selected.draftId}
            complaint={state.complaint}
            selected={state.selected}
            evidence={state.result.evidence}
            dispatch={dispatch}
          />
        )}
        {state.screen === 'done' && <DoneScreen finalAnswer={state.finalAnswer ?? ''} dispatch={dispatch} />}
      </main>
    </div>
  );
}
