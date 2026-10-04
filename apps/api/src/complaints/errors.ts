/** 상태 전이 도메인 에러. HTTP 매핑은 API 계층에서 한다. 메시지에 민원 원문·답변 본문을 넣지 않는다. */

export class ComplaintNotFoundError extends Error {
  constructor(readonly complaintId: string) {
    super('민원을 찾을 수 없습니다.');
    this.name = 'ComplaintNotFoundError';
  }
}

/** 다른 요청이 먼저 상태를 바꿔 조건부 갱신이 0건이 된 경우 */
export class ConcurrentTransitionError extends Error {
  constructor() {
    super('다른 요청이 먼저 민원 상태를 변경했습니다. 새로고침 후 다시 시도해 주세요.');
    this.name = 'ConcurrentTransitionError';
  }
}

/** 전이 표로는 허용되지만 전제 조건이 맞지 않는 경우 (예: 선택된 후보 없이 승인) */
export class TransitionPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionPreconditionError';
  }
}

/** 발송 전 임베딩 실패. 상태는 sent로 바뀌지 않는다. */
export class EmbeddingFailedError extends Error {
  constructor(cause?: unknown) {
    super('답변을 근거 코퍼스에 등록하기 위한 임베딩에 실패해 발송하지 않았습니다. 임베딩 서버 상태를 확인해 주세요.', {
      cause,
    });
    this.name = 'EmbeddingFailedError';
  }
}
