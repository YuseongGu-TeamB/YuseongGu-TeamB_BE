import type { Approach, GenerateApiResponse, Status } from '@minwon/contracts';

/** 계약 타입은 packages/contracts에서만 가져온다. 여기에는 화면에서 쓰는 API 응답 모양만 둔다. */
export type { Approach, GenerateApiResponse, Status };

export interface Accepted {
  complaint_id: string;
  run_id: string;
}

/** GET /complaints/:id 의 후보 하나 */
export interface DraftView {
  draft_id: string;
  approach: Approach;
  answer: string;
  used_sources: string[];
  assumptions: string[];
  edited_answer: string | null;
  selected: boolean;
  model: string;
}

/** GET /complaints/:id */
export interface ComplaintView {
  complaint_id: string;
  content: string;
  status: Status;
  drafts: DraftView[];
  generation: {
    run_id: string;
    status: 'running' | 'done' | 'error';
    model: string;
    error: string | null;
    result: GenerateApiResponse | null;
  } | null;
}

/** 접근 유형 한국어 라벨 (백엔드 프롬프트 프리셋과 같은 이름) */
export const APPROACH_LABEL: Record<Approach, string> = {
  PROCEDURE_GUIDE: '절차 안내 중심',
  ONSITE_CHECK: '현장 확인 일정 제시',
  IMMEDIATE_ACTION: '즉시 조치 안내',
  NOT_ELIGIBLE: '요건 미충족 안내',
};

/** GET /health */
export interface Health {
  status: 'ok' | 'degraded';
  search_engine: string;
  components: Record<'db' | 'embedding' | 'llm', { ok: boolean; local: boolean; host: string; model?: string }>;
}
