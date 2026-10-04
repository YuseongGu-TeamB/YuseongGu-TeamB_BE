import type { Status } from '@minwon/contracts';

/**
 * 허용 전이표 (backend-spec 3번, architecture 3-4번).
 *   received → draft → approved → sent
 *   예외: draft → draft (재생성. 기존 후보는 superseded로 보관)
 * 건너뛰기·역행 금지. 이 표를 "정리" 명목으로 바꾸지 말 것.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  received: ['draft'],
  draft: ['draft', 'approved'],
  approved: ['sent'],
  sent: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: Status,
    readonly to: Status,
  ) {
    super(`허용되지 않는 상태 전이입니다: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: Status, to: Status): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: Status, to: Status): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
