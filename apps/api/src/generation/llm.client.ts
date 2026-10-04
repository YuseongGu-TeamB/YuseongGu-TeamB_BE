import { Inject, Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import type { ZodType } from 'zod';
import { ENV, type Env } from '../config/env';
import { extractJsonObject } from './json-extract';
import { LlmOutputError, LlmUnavailableError } from './llm.errors';
import { schemaHint } from './prompts';

/** OpenAI 호환 클라이언트(DI 토큰). 테스트에서는 chat.completions.create만 있는 가짜로 바꾼다. */
export const LLM_CLIENT = Symbol('LLM_CLIENT');
export type ChatClient = Pick<OpenAI, 'chat'>;

export function createOpenAiClient(env: Env): ChatClient {
  return new OpenAI({
    baseURL: env.OPENAI_BASE_URL,
    apiKey: env.OPENAI_API_KEY,
    timeout: env.LLM_TIMEOUT_MS,
    maxRetries: 0, // 재시도는 아래 StructuredLlm이 정책대로 한다
  });
}

export interface StructuredCall<T> {
  /** 로그·timings용 단계명 (analyze, select, write:<APPROACH>) */
  stage: string;
  model: string;
  system: string;
  user: string;
  /** response_format에 보낼 JSON Schema (prompts.ts) */
  schema: Record<string, unknown>;
  /** 응답 검증. 서버가 스키마를 강제하지 않으므로 반드시 통과해야 한다 */
  validator: ZodType<T>;
}

export interface StructuredResult<T> {
  data: T;
  ms: number;
  tokens?: number;
  attempts: number;
}

const MAX_ATTEMPTS = 2; // 잘림·파싱 실패·검증 실패 시 1회 재시도

/**
 * OpenAI 호환 요청(messages + response_format)으로 구조화 출력을 받는다.
 * - json_schema(strict) 요청 자체가 실패하면 json_object + 스키마 system 메시지로 재요청(폴백)
 * - json_schema 요청은 성공했는데 응답이 스키마를 따르지 않으면(서버가 json_schema를 무시) 재시도는 폴백으로 보내고,
 *   그 모델은 이후 처음부터 폴백으로 요청한다(매번 두 번 호출하지 않도록). 전환은 로그로 남는다.
 * - 응답에서 JSON 객체 추출(코드펜스 제거) → zod 검증
 * - finish_reason=length·파싱 실패·검증 실패는 1회 재시도 후 LlmOutputError
 * 로그에는 단계명·소요 시간·토큰 수·finish_reason·폴백 여부만 남긴다(민원 원문·답변 본문 금지).
 */
@Injectable()
export class StructuredLlm {
  private readonly logger = new Logger('LLM');
  private readonly extraBody: Record<string, unknown>;
  /** json_schema를 무시하는 것으로 확인된 모델 → 처음부터 json_object 폴백 */
  private readonly schemaIgnored = new Set<string>();

  constructor(
    @Inject(LLM_CLIENT) private readonly client: ChatClient,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.extraBody = { ...(env.OLLAMA_OPTIONS ?? {}), ...(env.LLM_EXTRA_BODY ?? {}) };
  }

  async call<T>(c: StructuredCall<T>): Promise<StructuredResult<T>> {
    let totalMs = 0;
    let totalTokens: number | undefined;
    let lastReason = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const t0 = Date.now();
      const { res, mode } = await this.request(c);
      const markSchemaIgnored = () => {
        if (mode !== 'json_schema' || this.schemaIgnored.has(c.model)) return;
        this.schemaIgnored.add(c.model);
        this.logger.warn(`model=${c.model} json_schema 응답이 스키마를 따르지 않음 → 이후 json_object 폴백 사용`);
      };
      const ms = Date.now() - t0;
      totalMs += ms;
      const tokens = res.usage?.completion_tokens;
      if (tokens !== undefined) totalTokens = (totalTokens ?? 0) + tokens;
      const choice = res.choices?.[0];
      const finishReason = choice?.finish_reason ?? 'unknown';
      this.logger.log(
        `stage=${c.stage} attempt=${attempt} mode=${mode} ms=${ms} tokens=${tokens ?? '-'} finish_reason=${finishReason}`,
      );

      if (finishReason === 'length') {
        lastReason = `max_tokens(${this.env.LLM_MAX_TOKENS})에서 응답이 잘림`;
        this.logger.warn(`stage=${c.stage} attempt=${attempt} 잘림(finish_reason=length)`);
        continue;
      }
      let raw: unknown;
      try {
        raw = extractJsonObject(choice?.message?.content);
      } catch {
        lastReason = 'JSON 파싱 실패';
        this.logger.warn(`stage=${c.stage} attempt=${attempt} JSON 파싱 실패`);
        markSchemaIgnored();
        continue;
      }
      const parsed = c.validator.safeParse(raw);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].join(',');
        lastReason = `스키마 불일치(${fields})`;
        this.logger.warn(`stage=${c.stage} attempt=${attempt} 스키마 불일치 fields=${fields}`);
        markSchemaIgnored();
        continue;
      }
      return { data: parsed.data, ms: totalMs, tokens: totalTokens, attempts: attempt };
    }
    throw new LlmOutputError(c.stage, lastReason);
  }

  private async request(c: StructuredCall<unknown>): Promise<{ res: OpenAI.ChatCompletion; mode: string }> {
    const base = {
      model: c.model,
      max_tokens: this.env.LLM_MAX_TOKENS,
      temperature: this.env.LLM_TEMPERATURE,
      ...this.extraBody,
    };
    if (!this.schemaIgnored.has(c.model)) {
      try {
        const res = await this.client.chat.completions.create({
          ...base,
          messages: [
            { role: 'system', content: c.system },
            { role: 'user', content: c.user },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'response', schema: c.schema, strict: true } },
        });
        return { res, mode: 'json_schema' };
      } catch (e) {
        if (!isFallbackable(e)) throw toUnavailable(e, this.env);
        this.logger.warn(`stage=${c.stage} json_schema 요청 실패(status=${statusOf(e)}) → json_object 폴백`);
      }
    }
    try {
      const res = await this.client.chat.completions.create({
        ...base,
        messages: [
          { role: 'system', content: schemaHint(c.schema) },
          { role: 'system', content: c.system },
          { role: 'user', content: c.user },
        ],
        response_format: { type: 'json_object' },
      });
      return { res, mode: 'json_object(fallback)' };
    } catch (e) {
      throw toUnavailable(e, this.env);
    }
  }
}

/** json_schema 미지원으로 볼 수 있는 실패(요청 형식 거부 등)만 폴백한다. 연결·인증·모델 없음은 폴백해도 소용없다. */
function isFallbackable(e: unknown): boolean {
  if (e instanceof OpenAI.APIConnectionError) return false; // 타임아웃 포함
  if (e instanceof OpenAI.APIError) return ![401, 403, 404, 429].includes(e.status ?? 0);
  return false;
}

function statusOf(e: unknown): string {
  return e instanceof OpenAI.APIError ? String(e.status ?? '-') : '-';
}

function toUnavailable(e: unknown, env: Env): LlmUnavailableError {
  if (e instanceof OpenAI.APIConnectionTimeoutError) {
    return new LlmUnavailableError(`LLM 응답 시간이 초과되었습니다(${Math.round(env.LLM_TIMEOUT_MS / 1000)}초). 잠시 후 다시 시도해 주세요.`, e);
  }
  if (e instanceof OpenAI.APIConnectionError) {
    return new LlmUnavailableError('LLM 서버에 연결할 수 없습니다. 서버 주소(OPENAI_BASE_URL)와 실행 상태를 확인해 주세요.', e);
  }
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError) {
    return new LlmUnavailableError('LLM 서버 인증에 실패했습니다. API 키(OPENAI_API_KEY)를 확인해 주세요.', e);
  }
  if (e instanceof OpenAI.NotFoundError) {
    return new LlmUnavailableError('LLM 서버에서 모델을 찾을 수 없습니다. MODEL 설정과 서버의 모델 목록을 확인해 주세요.', e);
  }
  if (e instanceof OpenAI.RateLimitError) {
    return new LlmUnavailableError('LLM 서버 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.', e);
  }
  return new LlmUnavailableError('LLM 서버 오류로 답변을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.', e);
}
