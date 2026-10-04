import type { Approach } from '@minwon/contracts';

/** 계약·API 응답 타입은 packages/contracts에서만 정의한다. 여기서는 다시 내보내기만 한다. */
export type {
  Approach,
  ComplaintView,
  DraftView,
  GenerateAccepted as Accepted,
  GenerateApiResponse,
  Health,
  Status,
} from '@minwon/contracts';

/** 접근 유형 한국어 라벨 (백엔드 프롬프트 프리셋과 같은 이름) */
export const APPROACH_LABEL: Record<Approach, string> = {
  PROCEDURE_GUIDE: '절차 안내 중심',
  ONSITE_CHECK: '현장 확인 일정 제시',
  IMMEDIATE_ACTION: '즉시 조치 안내',
  NOT_ELIGIBLE: '요건 미충족 안내',
};
