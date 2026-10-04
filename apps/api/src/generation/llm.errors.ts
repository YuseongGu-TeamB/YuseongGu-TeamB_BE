/** LLM 관련 에러. 메시지는 담당자가 읽는 한국어이며 민원 원문·답변 본문을 넣지 않는다. */

export class LlmUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'LlmUnavailableError';
  }
}

/** 재시도 후에도 잘림·JSON 파싱 실패·스키마 불일치 */
export class LlmOutputError extends Error {
  constructor(
    readonly stage: string,
    readonly reason: string,
  ) {
    super(`답변 생성 결과를 해석하지 못했습니다(${stageLabel(stage)}: ${reason}). 다시 시도해 주세요.`);
    this.name = 'LlmOutputError';
  }
}

const STAGE_LABELS: Record<string, string> = {
  search: '근거 검색',
  analyze: '민원 분석',
  select: '근거 선별·접근 결정',
  write: '답변 작성',
};

export function stageLabel(stage: string): string {
  if (stage.startsWith('write:')) return `답변 작성(${stage.slice('write:'.length)})`;
  return STAGE_LABELS[stage] ?? stage;
}
