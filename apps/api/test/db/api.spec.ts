import { GenerateApiResponseSchema } from '@minwon/contracts';
import { type INestApplication, type LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import OpenAI from 'openai';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { sentSource } from '../../src/corpus/corpus.repository';
import { EMBEDDING_PROVIDER } from '../../src/corpus/embedding.port';
import { GenerationRunner } from '../../src/generation/generation.runner';
import { LLM_CLIENT } from '../../src/generation/llm.client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FakeChatClient, happyHandler } from '../fake-llm';
import { FakeEmbedding, resetDb } from './helpers';

/** 로그에 민원 원문·답변 본문이 남지 않는지 확인하기 위해 모든 로그를 모은다 */
class CaptureLogger implements LoggerService {
  lines: string[] = [];
  log = (m: unknown) => void this.lines.push(String(m));
  error = (m: unknown) => void this.lines.push(String(m));
  warn = (m: unknown) => void this.lines.push(String(m));
  debug = (m: unknown) => void this.lines.push(String(m));
  verbose = (m: unknown) => void this.lines.push(String(m));
}

/** SSE 응답 본문을 이벤트 목록으로 */
function parseSse(text: string): { type: string; data: Record<string, unknown> }[] {
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((block) => {
      const type = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      return { type, data: JSON.parse(data) };
    });
}

const COMPLAINT = '합성 민원: 지족로364번길 불법주정차가 심합니다. 단속 강화해주세요. 연락처 010-0000-0000';

describe('API (접수 → 생성 → SSE → 선택·수정 → 승인 → 발송)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let runner: GenerationRunner;
  const fake = new FakeChatClient(happyHandler());
  const embedding = new FakeEmbedding();
  const logger = new CaptureLogger();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.SEARCH_ENGINE = 'mock';
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_CLIENT)
      .useValue(fake.asClient())
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(embedding)
      .compile();
    app = mod.createNestApplication({ logger });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    runner = app.get(GenerationRunner);
  });

  beforeEach(async () => {
    fake.handler = happyHandler();
    fake.calls = [];
    fake.delayMs = 0;
    embedding.fail = false;
    embedding.calls = [];
    await resetDb(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function generate(id: string) {
    const res = await http().post(`/complaints/${id}/generate`).expect(202);
    await runner.waitFor(res.body.run_id);
    return res.body as { complaint_id: string; run_id: string };
  }

  it('전체 흐름: 생성 결과가 SSE done·GET에 같게 나오고, 발송하면 수정본이 코퍼스에 들어간다', async () => {
    const created = await http().post('/complaints').send({ content: COMPLAINT }).expect(201);
    expect(created.body).toMatchObject({ status: 'received', drafts: [], generation: null });
    const id = created.body.complaint_id as string;

    const accepted = await generate(id);
    expect(accepted).toEqual({ complaint_id: id, run_id: expect.any(String) });

    // 끝난 뒤 구독해도 지난 이벤트부터 받는다
    const sse = await http().get(`/complaints/${id}/progress`).expect(200).expect('content-type', /text\/event-stream/);
    const events = parseSse(sse.text);
    expect(events.map((e) => e.type)).toEqual([
      'run_started',
      'stage_started', 'stage_completed', // search
      'stage_started', 'stage_completed', // analyze
      'stage_started', 'stage_completed', // select
      'stage_started', 'stage_started', // write × 2 (병렬)
      'candidate_completed', 'candidate_completed',
      'done',
    ]);
    expect(events.every((e) => e.data.run_id === accepted.run_id && e.data.model === 'qwen2.5:7b')).toBe(true);

    // done 이벤트 = run_id + GenerateApiResponse 전체
    const { run_id: _runId, ...payload } = events.at(-1)!.data;
    const done = GenerateApiResponseSchema.parse(payload);
    expect(done).toMatchObject({ complaint_id: id, status: 'draft', model: 'qwen2.5:7b', failed: [] });
    expect(done.result.candidates.map((c) => c.approach)).toEqual(['PROCEDURE_GUIDE', 'ONSITE_CHECK']);
    expect(done.drafts.map((d) => d.approach)).toEqual(['PROCEDURE_GUIDE', 'ONSITE_CHECK']);

    const view = await http().get(`/complaints/${id}`).expect(200);
    expect(view.body.status).toBe('draft');
    expect(view.body.generation).toMatchObject({ run_id: accepted.run_id, status: 'done', result: done });
    expect(view.body.drafts.map((d: { draft_id: string }) => d.draft_id)).toEqual(done.drafts.map((d) => d.draft_id));

    const target = done.drafts[1].draft_id;
    await http().patch(`/drafts/${target}`).send({ selected: true, edited_answer: '담당자 수정본입니다.' }).expect(200);
    await http().post(`/complaints/${id}/approve`).expect(200).expect((r) => expect(r.body.status).toBe('approved'));
    // 승인 후에는 수정 불가
    await http().patch(`/drafts/${target}`).send({ edited_answer: '또 수정' }).expect(409);

    await http().post(`/complaints/${id}/send`).expect(200).expect((r) => expect(r.body.status).toBe('sent'));
    const corpus = await prisma.corpusEntry.findMany();
    expect(corpus).toMatchObject([{ source: sentSource(id), content: '담당자 수정본입니다.', origin: 'sent' }]);

    // 로그에 민원 원문·답변 본문이 없다
    const logs = logger.lines.join('\n');
    expect(logs).not.toContain('지족로');
    expect(logs).not.toContain('010-0000-0000');
    expect(logs).not.toContain('답변입니다');
    expect(logs).toMatch(/stage=analyze attempt=1 mode=json_schema ms=\d+ tokens=20 finish_reason=stop/);
  });

  it('진행 중에 구독하면 지난 이벤트 + 이후 이벤트를 모두 받는다', async () => {
    fake.delayMs = 30;
    const { body } = await http().post('/complaints/quick').send({ content: COMPLAINT }).expect(202);
    const sse = await http().get(`/complaints/${body.complaint_id}/progress`).expect(200);
    const types = parseSse(sse.text).map((e) => e.type);
    expect(types[0]).toBe('run_started');
    expect(types.at(-1)).toBe('done');
  });

  it('생성 중 새 생성 요청은 409', async () => {
    fake.delayMs = 50;
    const { body } = await http().post('/complaints/quick').send({ content: COMPLAINT }).expect(202);
    const r = await http().post(`/complaints/${body.complaint_id}/generate`).expect(409);
    expect(r.body).toEqual({ statusCode: 409, error: 'GenerationInProgressError', message: expect.stringContaining('생성하는 중') });
    await runner.waitFor(body.run_id);
  });

  it('재생성하면 상태는 draft 그대로, 이전 후보는 superseded라 선택할 수 없다', async () => {
    const { body } = await http().post('/complaints').send({ content: COMPLAINT });
    await generate(body.complaint_id);
    const first = (await http().get(`/complaints/${body.complaint_id}`)).body.drafts[0].draft_id;

    fake.handler = happyHandler(['IMMEDIATE_ACTION']);
    await generate(body.complaint_id);
    const view = (await http().get(`/complaints/${body.complaint_id}`)).body;
    expect(view.status).toBe('draft');
    expect(view.drafts.map((d: { approach: string }) => d.approach)).toEqual(['IMMEDIATE_ACTION']);
    await http().patch(`/drafts/${first}`).send({ selected: true }).expect(409);
  });

  it('후보 선택은 민원당 1개: 다른 후보를 선택하면 이전 선택이 풀린다', async () => {
    const { body } = await http().post('/complaints').send({ content: COMPLAINT });
    await generate(body.complaint_id);
    const [a, b] = (await http().get(`/complaints/${body.complaint_id}`)).body.drafts.map((d: { draft_id: string }) => d.draft_id);
    await http().patch(`/drafts/${a}`).send({ selected: true }).expect(200);
    await http().patch(`/drafts/${b}`).send({ selected: true }).expect(200);
    const drafts = (await http().get(`/complaints/${body.complaint_id}`)).body.drafts;
    expect(drafts.map((d: { selected: boolean }) => d.selected)).toEqual([false, true]);
  });

  it('모든 후보가 실패하면 error 이벤트로 끝나고 상태는 received 그대로', async () => {
    const base = happyHandler();
    fake.handler = (stage) => (stage.startsWith('write:') ? { content: '형식 없는 문장' } : base(stage));
    const { body } = await http().post('/complaints').send({ content: COMPLAINT });
    await generate(body.complaint_id);

    const events = parseSse((await http().get(`/complaints/${body.complaint_id}/progress`)).text);
    expect(events.filter((e) => e.type === 'candidate_failed')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'error', data: { message: expect.stringContaining('모든 답변 후보 생성에 실패') } });
    const view = (await http().get(`/complaints/${body.complaint_id}`)).body;
    expect(view.status).toBe('received');
    expect(view.generation).toMatchObject({ status: 'error', result: null });
  });

  it('LLM 서버 장애는 담당자용 한국어 메시지로 끝난다', async () => {
    fake.handler = () => ({ throw: new OpenAI.APIConnectionError({ message: 'ECONNREFUSED' }) });
    const { body } = await http().post('/complaints').send({ content: COMPLAINT });
    await generate(body.complaint_id);
    const view = (await http().get(`/complaints/${body.complaint_id}`)).body;
    expect(view.generation.error).toBe('LLM 서버에 연결할 수 없습니다. 서버 주소(OPENAI_BASE_URL)와 실행 상태를 확인해 주세요.');
  });

  it('승인·발송된 민원은 다시 생성할 수 없다(409)', async () => {
    const { body } = await http().post('/complaints').send({ content: COMPLAINT });
    await generate(body.complaint_id);
    const d = (await http().get(`/complaints/${body.complaint_id}`)).body.drafts[0].draft_id;
    await http().patch(`/drafts/${d}`).send({ selected: true });
    await http().post(`/complaints/${body.complaint_id}/approve`).expect(200);
    await http().post(`/complaints/${body.complaint_id}/generate`).expect(409);
  });

  it('선택 없이 승인하면 409, received에서 발송하면 409', async () => {
    const { body } = await http().post('/complaints').send({ content: COMPLAINT });
    await http().post(`/complaints/${body.complaint_id}/send`).expect(409);
    await generate(body.complaint_id);
    const r = await http().post(`/complaints/${body.complaint_id}/approve`).expect(409);
    expect(r.body.message).toContain('선택된 답변 후보가 없습니다');
  });

  it('발송 시 임베딩 실패는 503이고 상태는 approved 그대로', async () => {
    const { body } = await http().post('/complaints').send({ content: COMPLAINT });
    await generate(body.complaint_id);
    const d = (await http().get(`/complaints/${body.complaint_id}`)).body.drafts[0].draft_id;
    await http().patch(`/drafts/${d}`).send({ selected: true });
    await http().post(`/complaints/${body.complaint_id}/approve`);
    embedding.fail = true;
    await http().post(`/complaints/${body.complaint_id}/send`).expect(503);
    expect((await http().get(`/complaints/${body.complaint_id}`)).body.status).toBe('approved');
    expect(await prisma.corpusEntry.count()).toBe(0);
  });

  describe('입력 검증·에러 형식', () => {
    it.each([
      ['빈 본문', {}],
      ['공백 본문', { content: '   ' }],
      ['길이 초과', { content: 'a'.repeat(5001) }],
      ['알 수 없는 필드', { content: '민원', title: '제목' }],
    ])('%s → 400', async (_n, payload) => {
      const r = await http().post('/complaints').send(payload).expect(400);
      expect(r.body).toMatchObject({ statusCode: 400, error: 'ValidationError', message: expect.any(String) });
    });

    it('PATCH 본문이 비면 400', async () => {
      const { body } = await http().post('/complaints').send({ content: COMPLAINT });
      await generate(body.complaint_id);
      const d = (await http().get(`/complaints/${body.complaint_id}`)).body.drafts[0].draft_id;
      await http().patch(`/drafts/${d}`).send({}).expect(400);
    });

    it('없는 민원·잘못된 id는 404', async () => {
      await http().get('/complaints/00000000-0000-4000-8000-000000000000').expect(404);
      await http().get('/complaints/not-a-uuid').expect(404);
      await http().post('/complaints/00000000-0000-4000-8000-000000000000/generate').expect(404);
      await http().get('/complaints/00000000-0000-4000-8000-000000000000/progress').expect(404);
    });

    it('GET /health: 구성요소별 연결 상태와 로컬 여부', async () => {
      const r = await http().get('/health').expect(200);
      expect(r.body).toMatchObject({ status: expect.stringMatching(/^(ok|degraded)$/), search_engine: 'mock' });
      expect(r.body.components.db).toMatchObject({ ok: true, local: true, host: 'localhost', required_local: true });
      expect(r.body.components.embedding).toMatchObject({ ok: true, local: true, required_local: true });
      expect(r.body.components.llm).toMatchObject({ local: true, required_local: false, model: 'qwen2.5:7b' });
      expect(JSON.stringify(r.body)).not.toContain('OPENAI_API_KEY');
    });

    it('Swagger 문서가 /docs에 있다', async () => {
      await http().get('/docs').expect(200);
    });
  });
});
