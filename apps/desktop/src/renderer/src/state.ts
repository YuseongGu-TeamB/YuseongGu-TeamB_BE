export type Screen = 'input' | 'candidates' | 'edit' | 'done';

export interface AppState {
  screen: Screen;
}

export type Action = { type: 'go'; screen: Screen } | { type: 'reset' };

export const initialState: AppState = { screen: 'input' };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'go':
      return { ...state, screen: action.screen };
    case 'reset':
      return initialState;
  }
}
