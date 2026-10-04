import type { Approach } from '@minwon/contracts';
import type { ChatClient } from '../src/generation/llm.client';

type Body = {
  model: string;
  messages: { role: string; content: string }[];
  response_format?: { type: string };
  [k: string]: unknown;
};

export interface FakeReply {
  content?: string | null;
  finish_reason?: string;
  completion_tokens?: number;
  /** 지정하면 응답 대신 이 에러를 던진다 */
  throw?: unknown;
}

/** 단계(analyze/select/write:<APPROACH>)를 시스템 프롬프트로 판별 */
export function stageOf(body: Body): string {
  const system = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  if (system.includes('현재 단계: 민원 분석')) return 'analyze';
  if (system.includes('현재 단계: 근거 선별')) return 'select';
  const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
  const approach = /\[지정된 접근 유형\]\n(\w+)/.exec(user)?.[1];
  return `write:${approach}`;
}

/**
 * OpenAI chat.completions.create만 흉내 내는 가짜 클라이언트.
 * handler가 단계별 응답을 정한다. 모든 요청 본문은 calls에 남는다(내용 검증용).
 */
export class FakeChatClient {
  calls: Body[] = [];
  inFlight = 0;
  maxInFlight = 0;
  delayMs = 0;

  constructor(public handler: (stage: string, body: Body, call: number) => FakeReply) {}

  readonly chat = {
    completions: {
      create: async (body: Body) => {
        this.calls.push(body);
        const n = this.calls.length;
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
          if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
          const reply = this.handler(stageOf(body), body, n);
          if (reply.throw) throw reply.throw;
          return {
            id: `fake-${n}`,
            object: 'chat.completion',
            created: 0,
            model: body.model,
            choices: [
              {
                index: 0,
                finish_reason: reply.finish_reason ?? 'stop',
                message: { role: 'assistant', content: reply.content ?? null, refusal: null },
                logprobs: null,
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: reply.completion_tokens ?? 20, total_tokens: 30 },
          };
        } finally {
          this.inFlight--;
        }
      },
    },
  };

  asClient(): ChatClient {
    return this as unknown as ChatClient;
  }
}

export const json = (v: unknown) => ({ content: JSON.stringify(v) });

/** 정상 응답을 주는 기본 핸들러. approaches로 생성할 접근 유형을 정한다. */
export function happyHandler(
  approaches: Approach[] = ['PROCEDURE_GUIDE', 'ONSITE_CHECK'],
  opts: { sources?: string[]; answerable?: boolean; missing?: string[] } = {},
) {
  return (stage: string): FakeReply => {
    if (stage === 'analyze') {
      return json({
        request_summary: '단속 강화 요청',
        missing_info: opts.missing ?? [],
        is_answerable: opts.answerable ?? true,
      });
    }
    if (stage === 'select') return json({ selected_sources: opts.sources ?? ['K-0001'], approaches });
    const approach = stage.slice('write:'.length);
    return json({
      answer: `${approach} 답변입니다.`,
      approach,
      used_sources: opts.sources ?? ['K-0001'],
      assumptions: [],
    });
  };
}
