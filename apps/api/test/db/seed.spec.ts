import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { sentSource } from '../../src/corpus/corpus.repository';
import { EMBEDDING_PROVIDER } from '../../src/corpus/embedding.port';
import { LLM_CLIENT } from '../../src/generation/llm.client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { parseSeedWorkbook } from '../../src/seed/seed.service';
import { FakeChatClient, happyHandler } from '../fake-llm';
import { createDraft, FakeEmbedding, makeServices, resetDb, selectDraft } from './helpers';

const KEY = 'test-dev-key';

async function xlsx(rows: (string | number | undefined)[][], header: string[] = ['source', 'content']): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('seed');
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function makeApp(devApi: boolean, embedding: FakeEmbedding): Promise<INestApplication> {
  process.env.DEV_API_ENABLED = String(devApi);
  process.env.DEV_API_KEY = KEY;
  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot({ devApi })] })
    .overrideProvider(LLM_CLIENT)
    .useValue(new FakeChatClient(happyHandler()).asClient())
    .overrideProvider(EMBEDDING_PROVIDER)
    .useValue(embedding)
    .compile();
  const app = mod.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

describe('개발자 시드 API (/dev)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const embedding = new FakeEmbedding();
  const s = makeServices();
  const http = () => request(app.getHttpServer());
  const upload = (buf: Buffer, query = '', name = 'seed.xlsx') =>
    http().post(`/dev/seed/import${query}`).set('X-Dev-Key', KEY).attach('file', buf, name);
  const contents = async () =>
    (await prisma.corpusEntry.findMany({ orderBy: { source: 'asc' }, select: { source: true, content: true, origin: true } }));

  beforeAll(async () => {
    app = await makeApp(true, embedding);
    prisma = app.get(PrismaService);
  });
  beforeEach(async () => {
    embedding.fail = false;
    embedding.failOn = undefined;
    embedding.calls = [];
    await resetDb(prisma);
  });
  afterAll(async () => {
    await app.close();
    await s.prisma.$disconnect();
  });

  /** 실제 발송 경로로 sent 항목을 하나 만든다 */
  async function makeSent(): Promise<string> {
    const c = await createDraft(s, ['발송된 답변']);
    await selectDraft(s, c.id, 'PROCEDURE_GUIDE');
    await s.state.transition(c.id, { to: 'approved' });
    await s.send.send(c.id);
    return sentSource(c.id);
  }

  it('양식: 헤더 + 예시 1행이고 그대로 다시 읽힌다', async () => {
    const r = await http().get('/dev/seed/template.xlsx').set('X-Dev-Key', KEY).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    const rows = await parseSeedWorkbook(r.body as Buffer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ row: 2, source: '' });
  });

  it('정상 파일: 추가하고, source가 비면 S-0001 형식으로 자동 부여한다(기존·파일 번호와 겹치지 않게)', async () => {
    const r = await upload(await xlsx([['', '첫 답변'], ['S-0100', '둘째 답변'], [undefined, '셋째 답변'], ['', ''], ['K_custom-1', '넷째']])).expect(200);
    expect(r.body).toEqual({ total: 4, inserted: 4, updated: 0, skipped: 0, errors: [] });
    expect((await contents()).map((c) => c.source)).toEqual(['K_custom-1', 'S-0100', 'S-0101', 'S-0102']);
    expect((await contents()).every((c) => c.origin === 'seed')).toBe(true);
  });

  it('append: 같은 source는 내용 갱신 후 재임베딩, 내용이 같으면 임베딩하지 않고 건너뛴다', async () => {
    await upload(await xlsx([['S-0001', 'A'], ['S-0002', 'B']])).expect(200);
    embedding.calls = [];
    const r = await upload(await xlsx([['S-0001', 'A'], ['S-0002', 'B 수정']])).expect(200);
    expect(r.body).toEqual({ total: 2, inserted: 0, updated: 1, skipped: 1, errors: [] });
    expect(embedding.calls).toEqual([['B 수정']]);
    expect((await contents()).map((c) => c.content)).toEqual(['A', 'B 수정']);
  });

  it('빈 content·길이 초과·source 형식 오류 행은 건너뛰고 오류로 보고한다', async () => {
    const r = await upload(
      await xlsx([['S-0001', ''], ['', 'x'.repeat(2001)], ['bad source!', '내용'], ['S-0004', '정상']]),
    ).expect(200);
    expect(r.body).toMatchObject({ total: 4, inserted: 1, updated: 0, skipped: 3 });
    expect(r.body.errors).toEqual([
      { row: 2, reason: expect.stringContaining('비어 있습니다') },
      { row: 3, reason: expect.stringContaining('2,000자') },
      { row: 4, reason: expect.stringContaining('source 형식') },
    ]);
  });

  it('파일 안에서 source가 중복되면 해당 행들이 모두 오류', async () => {
    const r = await upload(await xlsx([['S-0001', 'A'], ['S-0001', 'B'], ['S-0002', 'C']])).expect(200);
    expect(r.body).toMatchObject({ inserted: 1, skipped: 2 });
    expect(r.body.errors.map((e: { row: number }) => e.row)).toEqual([2, 3]);
  });

  it('발송 항목(origin=sent)과 겹치는 source는 오류이고 sent 항목은 그대로다', async () => {
    const sent = await makeSent();
    const r = await upload(await xlsx([[sent, '덮어쓰기 시도']])).expect(200);
    expect(r.body.errors).toEqual([{ row: 2, reason: expect.stringContaining('origin=sent') }]);
    expect(await contents()).toEqual([{ source: sent, content: '발송된 답변', origin: 'sent' }]);
  });

  it('헤더에 content가 없으면 400', async () => {
    const r = await upload(await xlsx([['S-0001', '내용']], ['source', '본문'])).expect(400);
    expect(r.body).toMatchObject({ statusCode: 400, error: 'SeedFileError', message: expect.stringContaining('content 열') });
  });

  it('5MB를 넘으면 413(한국어 메시지)', async () => {
    const r = await upload(Buffer.alloc(5 * 1024 * 1024 + 1, 0x50)).expect(413);
    expect(r.body.message).toContain('5MB');
  });

  it('.xlsx가 아니면 400 (확장자 / 내용)', async () => {
    await upload(Buffer.from('source,content\nS-0001,a'), '', 'seed.csv').expect(400);
    const r = await upload(Buffer.from('source,content\nS-0001,a'), '', 'fake.xlsx').expect(400);
    expect(r.body.message).toContain('.xlsx');
  });

  it('2,000행을 넘으면 400', async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => ['', `내용 ${i}`]);
    await upload(await xlsx(rows)).expect(400);
    expect(await prisma.corpusEntry.count()).toBe(0);
  });

  it('파일이 없으면 400', async () => {
    await http().post('/dev/seed/import').set('X-Dev-Key', KEY).expect(400);
  });

  it('dryRun=true: 같은 결과를 돌려주지만 DB·임베딩은 그대로', async () => {
    await upload(await xlsx([['S-0001', 'A']])).expect(200);
    embedding.calls = [];
    const r = await upload(await xlsx([['S-0001', 'A 수정'], ['', '새 답변'], ['', '']]), '?dryRun=true').expect(200);
    expect(r.body).toEqual({ total: 2, inserted: 1, updated: 1, skipped: 0, errors: [] });
    expect(embedding.calls).toEqual([]);
    expect(await contents()).toEqual([{ source: 'S-0001', content: 'A', origin: 'seed' }]);
  });

  it('replace: seed만 지우고 새로 넣는다. sent 항목은 보존', async () => {
    const sent = await makeSent();
    await upload(await xlsx([['S-0001', '옛 시드 1'], ['S-0002', '옛 시드 2']])).expect(200);
    const r = await upload(await xlsx([['', '새 시드']]), '?mode=replace').expect(200);
    expect(r.body).toEqual({ total: 1, inserted: 1, updated: 0, skipped: 0, errors: [] });
    expect(await contents()).toEqual([
      { source: sent, content: '발송된 답변', origin: 'sent' },
      { source: 'S-0001', content: '새 시드', origin: 'seed' },
    ]);
  });

  it('임베딩이 실패한 행만 오류로 보고하고 나머지는 반영한다(부분 성공)', async () => {
    embedding.failOn = 'FAIL';
    const r = await upload(await xlsx([['', '정상 1'], ['', 'FAIL 행'], ['', '정상 2']])).expect(200);
    expect(r.body).toMatchObject({ total: 3, inserted: 2, skipped: 1 });
    expect(r.body.errors).toEqual([{ row: 3, reason: expect.stringContaining('임베딩') }]);
    expect((await contents()).map((c) => c.content)).toEqual(['정상 1', '정상 2']);
  });

  it('잘못된 쿼리 값은 400', async () => {
    await upload(await xlsx([['', 'a']]), '?mode=merge').expect(400);
  });

  it('목록·내보내기·삭제', async () => {
    const sent = await makeSent();
    await upload(await xlsx([['S-0001', 'A'], ['S-0002', 'x'.repeat(200)]])).expect(200);

    const list = (await http().get('/dev/seed').set('X-Dev-Key', KEY).expect(200)).body;
    expect(list.map((e: { source: string; origin: string }) => [e.source, e.origin])).toEqual([
      [sent, 'sent'],
      ['S-0001', 'seed'],
      ['S-0002', 'seed'],
    ]);
    expect(list[2].content.length).toBeLessThan(100);
    expect(list[0].created_at).toEqual(expect.any(String));

    const exported = await http().get('/dev/seed/export.xlsx').set('X-Dev-Key', KEY).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const rows = await parseSeedWorkbook(exported.body as Buffer);
    expect(rows.map((r) => r.source)).toEqual(['S-0001', 'S-0002']); // sent는 내보내지 않는다

    await http().delete('/dev/seed/S-0001').set('X-Dev-Key', KEY).expect(204);
    await http().delete('/dev/seed/S-0001').set('X-Dev-Key', KEY).expect(404);
    await http().delete(`/dev/seed/${sent}`).set('X-Dev-Key', KEY).expect(409);
    expect((await contents()).map((c) => c.source)).toEqual([sent, 'S-0002']);
  });

  it('재임베딩: 모든 항목을 현재 모델로 다시 임베딩한다(내용 불변)', async () => {
    const sent = await makeSent();
    await upload(await xlsx([['S-0001', 'A']])).expect(200);
    await prisma.$executeRaw`UPDATE corpus_entries SET embedding_model = 'old-model'`;
    const r = await http().post('/dev/corpus/reembed').set('X-Dev-Key', KEY).expect(200);
    expect(r.body).toEqual({ total: 2, updated: 2, failed: [] });
    const rows = await prisma.corpusEntry.findMany({ select: { source: true, embeddingModel: true, content: true } });
    expect(rows.every((e) => e.embeddingModel === 'fake-embed')).toBe(true);
    expect(rows.find((e) => e.source === sent)?.content).toBe('발송된 답변');
  });

  it('X-Dev-Key가 없거나 틀리면 401', async () => {
    await http().get('/dev/seed').expect(401);
    const r = await http().get('/dev/seed').set('X-Dev-Key', 'wrong').expect(401);
    expect(r.body).toMatchObject({ statusCode: 401, message: 'X-Dev-Key가 올바르지 않습니다.' });
    await http().post('/dev/corpus/reembed').set('X-Dev-Key', 'wrong').expect(401);
  });
});

describe('DEV_API_ENABLED=false', () => {
  it('/dev 라우트가 등록되지 않아 404', async () => {
    const app = await makeApp(false, new FakeEmbedding());
    try {
      await request(app.getHttpServer()).get('/dev/seed').set('X-Dev-Key', KEY).expect(404);
      await request(app.getHttpServer()).get('/dev/seed/template.xlsx').set('X-Dev-Key', KEY).expect(404);
      await request(app.getHttpServer()).post('/dev/corpus/reembed').set('X-Dev-Key', KEY).expect(404);
    } finally {
      await app.close();
    }
  });
});
