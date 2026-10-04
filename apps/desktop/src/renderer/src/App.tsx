import { useReducer } from 'react';
import { StepIndicator } from './components/StepIndicator';
import { CandidatesScreen } from './screens/CandidatesScreen';
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
  const go = (screen: Screen) => dispatch({ type: 'go', screen });

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="page-title-wrap between">
          <h1 className="h-tit">{TITLE_OF[state.screen]}</h1>
        </div>
        <StepIndicator current={STEP_OF[state.screen]} />
      </header>
      <main className="app-main">
        {state.screen === 'input' && <InputScreen dispatch={dispatch} complaintId={state.complaint?.id} />}
        {state.screen === 'candidates' && state.complaint && state.result && (
          <CandidatesScreen complaint={state.complaint} result={state.result} dispatch={dispatch} />
        )}
        {/* 화면 ③·완료는 4단계에서 채운다 */}
        <div className="app-actions">
          {state.screen === 'edit' && (
            <>
              <button type="button" className="krds-btn secondary" onClick={() => go('candidates')}>
                다른 후보 고르기
              </button>
              <button type="button" className="krds-btn primary" onClick={() => go('done')}>
                전송
              </button>
            </>
          )}
          {state.screen === 'done' && (
            <button type="button" className="krds-btn primary" onClick={() => dispatch({ type: 'reset' })}>
              새 민원 입력
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
