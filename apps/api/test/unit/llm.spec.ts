import OpenAI from 'openai';
import { z } from 'zod';
import { loadEnv } from '../../src/config/env';
import { extractJsonObject } from '../../src/generation/json-extract';
import { StructuredLlm } from '../../src/generation/llm.client';
import { LlmOutputError, LlmUnavailableError } from '../../src/generation/llm.errors';
import { FakeChatClient, json } from '../fake-llm';

const env = (over: Record<string, string> = {}) => loadEnv({ DATABASE_URL: 'postgresql://x', ...over });
const V = z.object({ a: z.number() });
const call = (llm: StructuredLlm) =>
  llm.call({ stage: 'analyze', model: 'm', system: 'S', user: 'U', schema: { type: 'object' }, validator: V });

describe('extractJsonObject', () => {
  it.each([
    ['그대로', '{"a":1}'],
    ['코드펜스', '```json\n{"a":1}\n```'],
    ['언어 없는 코드펜스', '```\n{"a":1}\n```'],
    ['앞뒤 문장', '다음과 같습니다.\n{"a":1}\n감사합니다.'],
  ])('%s', (_n, text) => {
    expect(extractJsonObject(text)).toEqual({ a: 1 });
  });

  it.each([['빈 응답', ''], ['일반 문장', '지족로 불법주정차 단속을 강화하겠습니다.'], ['배열', '[1,2]'], ['null', null]])(
    '%s는 실패',
    (_n, text) => {
      expect(() => extractJsonObject(text as string)).toThrow();
    },
  );
});

describe('StructuredLlm', () => {
  it('코드펜스로 감싼 응답도 추출·검증해 반환한다', async () => {
    const fake = new FakeChatClient(() => ({ content: '```json\n{"a": 3}\n```' }));
    const r = await call(new StructuredLlm(fake.asClient(), env()));
    expect(r).toMatchObject({ data: { a: 3 }, attempts: 1 });
    expect(fake.calls[0].response_format).toMatchObject({ type: 'json_schema' });
  });

  it('finish_reason=length면 1회 재시도한다', async () => {
    const fake = new FakeChatClient((_s, _b, n) => (n === 1 ? { content: '{"a":', finish_reason: 'length' } : json({ a: 1 })));
    const r = await call(new StructuredLlm(fake.asClient(), env()));
    expect(r.attempts).toBe(2);
    expect(r.tokens).toBe(40); // 두 번의 completion_tokens 합
  });

  it('잘림이 반복되면 명확한 에러', async () => {
    const fake = new FakeChatClient(() => ({ content: '{"a":', finish_reason: 'length' }));
    await expect(call(new StructuredLlm(fake.asClient(), env()))).rejects.toThrow(LlmOutputError);
    expect(fake.calls).toHaveLength(2);
  });

  it('JSON이 아닌 응답(일반 문장)은 1회 재시도 후 에러', async () => {
    const fake = new FakeChatClient(() => ({ content: '단속을 강화하겠습니다.' }));
    await expect(call(new StructuredLlm(fake.asClient(), env()))).rejects.toThrow(/JSON 파싱 실패/);
    expect(fake.calls).toHaveLength(2);
  });

  it('필드 누락·이름 변경(스키마 불일치)도 재시도 대상', async () => {
    const fake = new FakeChatClient((_s, _b, n) => (n === 1 ? json({ 답변: 1 }) : json({ a: 2 })));
    const r = await call(new StructuredLlm(fake.asClient(), env()));
    expect(r).toMatchObject({ data: { a: 2 }, attempts: 2 });
  });

  it('json_schema 요청이 거부되면 json_object + 스키마 system 메시지로 폴백한다', async () => {
    const fake = new FakeChatClient((_s, body) =>
      body.response_format?.type === 'json_schema'
        ? { throw: new OpenAI.BadRequestError(400, undefined, 'unsupported response_format', new Headers()) }
        : json({ a: 5 }),
    );
    const r = await call(new StructuredLlm(fake.asClient(), env()));
    expect(r.data).toEqual({ a: 5 });
    expect(fake.calls[1].response_format).toEqual({ type: 'json_object' });
    expect(fake.calls[1].messages[0].content).toMatch(/^다음 JSON 스키마를 따라 응답하라/);
  });

  it('json_schema를 무시하는 서버: 재시도는 폴백으로 보내고, 그 모델은 이후 처음부터 폴백', async () => {
    // json_schema 모드에선 필드명을 지어내고(서버가 스키마를 무시), 스키마를 system에 명시하면 맞춘다
    const fake = new FakeChatClient((_s, body) =>
      body.response_format?.type === 'json_schema' ? json({ 값: 1 }) : { content: '```json\n{"a": 7}\n```' },
    );
    const llm = new StructuredLlm(fake.asClient(), env());
    const first = await call(llm);
    expect(first).toMatchObject({ data: { a: 7 }, attempts: 2 });
    expect(fake.calls.map((c) => c.response_format?.type)).toEqual(['json_schema', 'json_object']);

    fake.calls = [];
    const second = await call(llm);
    expect(second).toMatchObject({ data: { a: 7 }, attempts: 1 });
    expect(fake.calls.map((c) => c.response_format?.type)).toEqual(['json_object']);
  });

  it('잘림(length)만으로는 폴백으로 바꾸지 않는다', async () => {
    const fake = new FakeChatClient((_s, _b, n) => (n === 1 ? { content: '{"a":', finish_reason: 'length' } : json({ a: 1 })));
    await call(new StructuredLlm(fake.asClient(), env()));
    expect(fake.calls.map((c) => c.response_format?.type)).toEqual(['json_schema', 'json_schema']);
  });

  it('연결 실패는 폴백 없이 한국어 에러', async () => {
    const fake = new FakeChatClient(() => ({ throw: new OpenAI.APIConnectionError({ message: 'ECONNREFUSED' }) }));
    await expect(call(new StructuredLlm(fake.asClient(), env()))).rejects.toThrow(LlmUnavailableError);
    await expect(call(new StructuredLlm(fake.asClient(), env()))).rejects.toThrow('LLM 서버에 연결할 수 없습니다');
    expect(fake.calls).toHaveLength(2); // 두 번 호출했고 각각 폴백 없이 1회씩
  });

  it('타임아웃은 한국어 에러', async () => {
    const fake = new FakeChatClient(() => ({ throw: new OpenAI.APIConnectionTimeoutError() }));
    await expect(call(new StructuredLlm(fake.asClient(), env({ LLM_TIMEOUT_MS: '90000' })))).rejects.toThrow(
      /응답 시간이 초과되었습니다\(90초\)/,
    );
  });

  it('OLLAMA_OPTIONS와 LLM_EXTRA_BODY를 요청 본문에 합친다(LLM_EXTRA_BODY 우선)', async () => {
    const fake = new FakeChatClient(() => json({ a: 1 }));
    await call(
      new StructuredLlm(
        fake.asClient(),
        env({ OLLAMA_OPTIONS: '{"keep_alive":-1,"num_ctx":4096}', LLM_EXTRA_BODY: '{"reasoning_effort":"low","num_ctx":2048}' }),
      ),
    );
    expect(fake.calls[0]).toMatchObject({ keep_alive: -1, num_ctx: 2048, reasoning_effort: 'low', max_tokens: 512, temperature: 0.3 });
  });

  it('설정하지 않으면 추가 파라미터를 보내지 않는다', async () => {
    const fake = new FakeChatClient(() => json({ a: 1 }));
    await call(new StructuredLlm(fake.asClient(), env()));
    expect(Object.keys(fake.calls[0]).sort()).toEqual(['max_tokens', 'messages', 'model', 'response_format', 'temperature']);
  });
});
