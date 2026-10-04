import type { SearchEngine, SearchResult } from '@minwon/contracts';
import { loadEnv } from '../../src/config/env';
import { StructuredLlm } from '../../src/generation/llm.client';
import { candidateValidator, GenerationPipeline, mapLimit, type PipelineEvent } from '../../src/generation/pipeline';
import { MockSearchEngine } from '../../src/search/mock-search.engine';
import { FakeChatClient, happyHandler, json } from '../fake-llm';

const env = (over: Record<string, string> = {}) => loadEnv({ DATABASE_URL: 'postgresql://x', ...over });

function pipeline(fake: FakeChatClient, search: SearchEngine = new MockSearchEngine(), over: Record<string, string> = {}) {
  const e = env(over);
  return new GenerationPipeline(new StructuredLlm(fake.asClient(), e), search, e);
}

describe('근거 enum 제한', () => {
  const ok = { answer: '답변', approach: 'PROCEDURE_GUIDE', used_sources: ['K-0001'], assumptions: [] };

  it('검색 결과에 있는 source는 통과', () => {
    expect(candidateValidator(['K-0001', 'K-0002'], 'PROCEDURE_GUIDE').safeParse(ok).success).toBe(true);
  });

  it('검색 결과에 없는 source는 거부', () => {
    const r = candidateValidator(['K-0001'], 'PROCEDURE_GUIDE').safeParse({ ...ok, used_sources: ['S-9999'] });
    expect(r.success).toBe(false);
  });

  it('검색 결과가 없으면 used_sources는 빈 배열만 허용', () => {
    const v = candidateValidator([], 'PROCEDURE_GUIDE');
    expect(v.safeParse({ ...ok, used_sources: [] }).success).toBe(true);
    expect(v.safeParse(ok).success).toBe(false);
  });

  it('지정한 접근 유형과 다른 approach는 거부', () => {
    expect(candidateValidator(['K-0001'], 'ONSITE_CHECK').safeParse(ok).success).toBe(false);
  });

  const writeCall = (fake: FakeChatClient) => {
    const c = fake.calls.find((x) => JSON.stringify(x.messages).includes('현재 단계: 답변 작성'))!;
    const schema = (c.response_format as unknown as { json_schema: { schema: { properties: { used_sources: unknown } } } })
      .json_schema.schema;
    return { user: c.messages.find((m) => m.role === 'user')!.content, usedSources: schema.properties.used_sources };
  };

  it('선별 단계 스키마는 검색 결과 전체로 enum 제한된다', async () => {
    const fake = new FakeChatClient(happyHandler(['PROCEDURE_GUIDE']));
    await pipeline(fake).run('민원', 'm');
    const select = fake.calls.find((x) => JSON.stringify(x.messages).includes('현재 단계: 근거 선별'))!;
    expect(JSON.stringify(select.response_format)).toContain('"enum":["K-0001","K-0002"]');
  });

  it('답변 작성에는 선별된 근거만 넘기고 enum도 그 안으로 제한한다', async () => {
    const fake = new FakeChatClient(happyHandler(['PROCEDURE_GUIDE'], { sources: ['K-0002'] }));
    await pipeline(fake).run('민원', 'm');
    const w = writeCall(fake);
    expect(w.usedSources).toMatchObject({ items: { enum: ['K-0002'] } });
    expect(w.user).toContain('- (K-0002)');
    expect(w.user).not.toContain('K-0001');
  });

  it('선별된 근거가 없으면 근거 없이 작성하고 used_sources는 빈 배열만 허용', async () => {
    const fake = new FakeChatClient(happyHandler(['PROCEDURE_GUIDE'], { sources: [] }));
    const out = await pipeline(fake).run('민원', 'm');
    const w = writeCall(fake);
    expect(w.usedSources).toMatchObject({ maxItems: 0 });
    expect(w.user).not.toContain('[근거 — 과거 승인 답변]');
    expect(out.result.candidates[0].used_sources).toEqual([]);
  });

  it('선별되지 않은 source를 used_sources에 쓰면 그 후보는 실패한다', async () => {
    const base = happyHandler(['PROCEDURE_GUIDE'], { sources: ['K-0002'] });
    const fake = new FakeChatClient((stage) =>
      stage.startsWith('write:')
        ? json({ answer: '답변', approach: 'PROCEDURE_GUIDE', used_sources: ['K-0001'], assumptions: [] })
        : base(stage),
    );
    const out = await pipeline(fake).run('민원', 'm');
    expect(out.result.candidates).toEqual([]);
    expect(out.failed[0].reason).toContain('스키마 불일치(used_sources');
  });
});

describe('GenerationPipeline', () => {
  it('검색 → 분석 → 선별 → 접근별 작성 순서로 후보를 만든다', async () => {
    const fake = new FakeChatClient(happyHandler(['PROCEDURE_GUIDE', 'ONSITE_CHECK']));
    const events: PipelineEvent[] = [];
    const out = await pipeline(fake).run('민원', 'm', (e) => events.push(e));

    expect(out.result).toEqual({
      candidates: [
        { answer: 'PROCEDURE_GUIDE 답변입니다.', approach: 'PROCEDURE_GUIDE', used_sources: ['K-0001'], assumptions: [] },
        { answer: 'ONSITE_CHECK 답변입니다.', approach: 'ONSITE_CHECK', used_sources: ['K-0001'], assumptions: [] },
      ],
      is_info_sufficient: true,
      insufficient_reason: null,
    });
    expect(out.failed).toEqual([]);
    expect(out.timings.map((t) => t.stage).slice(0, 3)).toEqual(['search', 'analyze', 'select']);
    expect(events.filter((e) => e.type === 'candidate_completed')).toHaveLength(2);
  });

  it('부분 실패: 후보 3개 중 1개 실패 → 2개 반환 + failed 1건', async () => {
    const base = happyHandler(['PROCEDURE_GUIDE', 'ONSITE_CHECK', 'IMMEDIATE_ACTION']);
    const fake = new FakeChatClient((stage, body, n) => (stage === 'write:ONSITE_CHECK' ? { content: '형식 없는 문장' } : base(stage)));
    const events: PipelineEvent[] = [];
    const out = await pipeline(fake).run('민원', 'm', (e) => events.push(e));

    expect(out.result.candidates.map((c) => c.approach)).toEqual(['PROCEDURE_GUIDE', 'IMMEDIATE_ACTION']);
    expect(out.failed).toEqual([{ approach: 'ONSITE_CHECK', reason: expect.stringContaining('답변 작성(ONSITE_CHECK)') }]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'candidate_failed', approach: 'ONSITE_CHECK' }));
  });

  it('is_answerable=false여도 생성을 계속하고 insufficient_reason을 "; "로 연결한다', async () => {
    const fake = new FakeChatClient(happyHandler(['PROCEDURE_GUIDE'], { answerable: false, missing: ['발생 시각', '차량번호'] }));
    const out = await pipeline(fake).run('민원', 'm');
    expect(out.result.is_info_sufficient).toBe(false);
    expect(out.result.insufficient_reason).toBe('발생 시각; 차량번호');
    expect(out.result.candidates).toHaveLength(1);
  });

  it('접근 유형이 비어 있으면 PROCEDURE_GUIDE', async () => {
    const fake = new FakeChatClient(happyHandler([]));
    const out = await pipeline(fake).run('민원', 'm');
    expect(out.result.candidates.map((c) => c.approach)).toEqual(['PROCEDURE_GUIDE']);
  });

  it('검색 결과가 없으면 used_sources는 비어야 한다', async () => {
    const empty: SearchEngine = { search: async (): Promise<SearchResult[]> => [] };
    const fake = new FakeChatClient(happyHandler(['PROCEDURE_GUIDE'], { sources: [] }));
    const out = await pipeline(fake, empty).run('민원', 'm');
    expect(out.result.candidates[0].used_sources).toEqual([]);
  });

  it('분석 단계가 실패하면 전체가 실패한다', async () => {
    const fake = new FakeChatClient((stage) => (stage === 'analyze' ? { content: '???' } : json({})));
    await expect(pipeline(fake).run('민원', 'm')).rejects.toThrow(/민원 분석/);
  });

  it('후보 병렬 생성은 LLM_CONCURRENCY 한도를 지킨다', async () => {
    const fake = new FakeChatClient(happyHandler(['PROCEDURE_GUIDE', 'ONSITE_CHECK', 'IMMEDIATE_ACTION']));
    fake.delayMs = 20;
    await pipeline(fake, undefined, { LLM_CONCURRENCY: '2' }).run('민원', 'm');
    expect(fake.maxInFlight).toBe(2);
  });

  it('사용한 모델명으로 호출한다', async () => {
    const fake = new FakeChatClient(happyHandler(['PROCEDURE_GUIDE']));
    await pipeline(fake).run('민원', 'gemma4:31b');
    expect(new Set(fake.calls.map((c) => c.model))).toEqual(new Set(['gemma4:31b']));
  });
});

describe('mapLimit', () => {
  it('순서를 유지한다', async () => {
    const out = await mapLimit([30, 10, 20], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });
});
