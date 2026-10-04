import type { Candidate } from '@minwon/contracts';
import type { GenerateApiResponse } from './types';

export type Screen = 'input' | 'candidates' | 'edit' | 'done';

export interface AppState {
  screen: Screen;
  /** 접수된 민원 (생성 시작 후) */
  complaint?: { id: string; content: string };
  /** 최신 생성 결과 */
  result?: GenerateApiResponse;
  /** 화면 ③에서 수정 중인 후보 */
  selected?: { draftId: string; candidate: Candidate };
  /** 완료 화면에 보여줄 최종 답변 */
  finalAnswer?: string;
}

export type Action =
  | { type: 'go'; screen: Screen }
  | { type: 'complaint'; id: string; content: string }
  | { type: 'generated'; result: GenerateApiResponse }
  | { type: 'selected'; draftId: string; candidate: Candidate }
  | { type: 'sent'; finalAnswer: string }
  | { type: 'reset' };

export const initialState: AppState = { screen: 'input' };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'go':
      return { ...state, screen: action.screen };
    case 'complaint':
      return { ...state, complaint: { id: action.id, content: action.content } };
    case 'generated':
      return { ...state, result: action.result, selected: undefined, screen: 'candidates' };
    case 'selected':
      return { ...state, selected: { draftId: action.draftId, candidate: action.candidate }, screen: 'edit' };
    case 'sent':
      return { ...state, finalAnswer: action.finalAnswer, screen: 'done' };
    case 'reset':
      return initialState;
  }
}
