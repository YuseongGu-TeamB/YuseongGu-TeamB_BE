import type { ChatClient } from '../generation/llm.client';

type Body = {
  model: string;
  messages: { role: string; content: string }[];
  response_format?: { type: string; json_schema?: { schema: { properties?: Record<string, { items?: { enum?: string[] } }> } } };
};

/**
 * `pnpm smoke --no-llm` 전용: 생성 단계만 대신하는 결정적 응답(네트워크 없음).
 * 검색·임베딩·벡터DB·발송 시 코퍼스 추가는 실제 구현을 그대로 탄다.
 */
export function offlineChatClient(): ChatClient {
  const create = async (body: Body) => {
    const system = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    const props = body.response_format?.json_schema?.schema.properties ?? {};
    const enumOf = (field: string) => props[field]?.items?.enum ?? [];

    let out: unknown;
    if (system.includes('현재 단계: 민원 분석')) {
      out = { request_summary: '불법주정차 단속 강화 요청', missing_info: [], is_answerable: true };
    } else if (system.includes('현재 단계: 근거 선별')) {
      out = { selected_sources: enumOf('selected_sources').slice(0, 2), approaches: ['PROCEDURE_GUIDE'] };
    } else {
      const approach = /\[지정된 접근 유형\]\n(\w+)/.exec(user)?.[1] ?? 'PROCEDURE_GUIDE';
      out = {
        answer: '불법주정차 단속 요청 민원에 답변드립니다. 해당 구간은 현장 확인 후 단속 계획에 반영하겠습니다.',
        approach,
        used_sources: enumOf('used_sources').slice(0, 1),
        assumptions: [],
      };
    }
    return {
      id: 'offline',
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(out), refusal: null }, logprobs: null }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  };
  return { chat: { completions: { create } } } as unknown as ChatClient;
}
