import { SearchResultSchema } from '@minwon/contracts';
import { Logger } from '@nestjs/common';
import pgvector from 'pgvector';
import { SendService } from '../../src/complaints/send.service';
import { loadEnv } from '../../src/config/env';
import { sentSource } from '../../src/corpus/corpus.repository';
import { EmbeddingCheck } from '../../src/corpus/embedding.check';
import type { EmbeddingProvider } from '../../src/corpus/embedding.port';
import { VectorSearchEngine } from '../../src/search/vector-search.engine';
import { createDraft, DIM, makeServices, regenerate, resetDb, selectDraft } from './helpers';

/** 핵심어가 들어 있으면 해당 축이 1인 고정 벡터 → 코사인 유사도 순서를 예측할 수 있다 */
const KEYWORDS = ['유예', '주민신고제', '단속', '쓰레기', '소음', '발송본'];
export class KeywordEmbedding implements EmbeddingProvider {
  model = 'fake-embed';
  fail = false;
  dim = DIM;
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    if (this.fail) throw new Error('embedding server down');
    return texts.map((t) => {
      const v = new Array(this.dim).fill(0);
      KEYWORDS.forEach((k, i) => {
        if (t.includes(k)) v[i] = 1;
      });
      v[this.dim - 1] = 0.01; // 0 벡터 방지
      return v;
    });
  }
}

describe('벡터 검색 (pgvector)', () => {
  const s = makeServices();
  const embedding = new KeywordEmbedding();
  const env = (over: Record<string, string> = {}) => loadEnv({ ...process.env, ...over });
  const engine = (over: Record<string, string> = {}) => new VectorSearchEngine(s.corpus, embedding, env(over));

  async function seed(source: string, content: string) {
    const [v] = await embedding.embed([content]);
    await s.prisma.$executeRaw`
      INSERT INTO corpus_entries (source, content, origin, embedding, embedding_model)
      VALUES (${source}, ${content}, 'seed', ${pgvector.toSql(v)}::vector, 'fake-embed')`;
  }

  beforeEach(async () => {
    embedding.fail = false;
    embedding.dim = DIM;
    await resetDb(s.prisma);
    await seed('S-0001', '저녁 유예(19:00~22:00) 시간에는 단속하지 않습니다.');
    await seed('S-0002', '주민신고제 구간은 24시간 단속 대상입니다.');
    await seed('S-0003', '쓰레기 무단투기는 현장 확인 후 조치합니다.');
  });
  afterAll(() => s.prisma.$disconnect());

  it('코사인 유사도 순으로 top_k개를 계약 형태로 반환한다', async () => {
    const results = await engine().search('주민신고제 구간 불법주정차 단속 요청', 2);
    expect(results).toHaveLength(2);
    expect(results[0].source).toBe('S-0002');
    for (const r of results) expect(SearchResultSchema.parse(r)).toEqual(r);
  });

  it('불변식: draft·approved·superseded 후보는 검색에 나오지 않고, 발송본만 다음 검색에 나온다(피드백 루프)', async () => {
    const c = await createDraft(s, ['소음 후보 A', '소음 후보 B']);
    await selectDraft(s, c.id, 'PROCEDURE_GUIDE');
    await regenerate(s, c.id, ['소음 재생성 후보 A', '소음 재생성 후보 B']); // 이전 후보 superseded
    await selectDraft(s, c.id, 'ONSITE_CHECK', '소음 발송본: 현장 확인 후 조치하겠습니다.');

    const query = '소음 민원 후보 재생성 발송본';
    const allSources = async () => (await engine().search(query, 10)).map((r) => r.source);
    const allContents = async () => (await engine().search(query, 10)).map((r) => r.content);

    expect(await allSources()).toEqual(expect.not.arrayContaining([sentSource(c.id)]));
    expect((await allContents()).some((t) => t.includes('후보'))).toBe(false);

    await s.state.transition(c.id, { to: 'approved' });
    expect((await allContents()).some((t) => t.includes('소음'))).toBe(false);

    // 발송은 FakeEmbedding이 아닌 같은 KeywordEmbedding으로
    await new SendService(s.prisma, s.state, embedding, env()).send(c.id);

    const top = (await engine().search('소음 민원', 1))[0];
    expect(top).toEqual({ source: sentSource(c.id), content: '소음 발송본: 현장 확인 후 조치하겠습니다.' });
    expect((await allContents()).some((t) => t.includes('후보'))).toBe(false);
  });

  it('임베딩 호출이 불가하면 키워드 매칭으로 폴백하고 경고를 남긴다', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    embedding.fail = true;
    const results = await engine().search('저녁 유예 시간 문의', 3);
    // S-0001: 저녁·유예·시간 3개 일치, S-0002: '24시간'으로 1개 일치, S-0003: 0개 → 제외
    expect(results.map((r) => r.source)).toEqual(['S-0001', 'S-0002']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('키워드 매칭으로 폴백'));
    warn.mockRestore();
  });

  it('키워드 폴백은 LIKE 특수문자를 그대로 문자로 취급한다', async () => {
    embedding.fail = true;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await engine().search('%% __', 3)).toEqual([]);
    jest.restoreAllMocks();
  });

  it('하이브리드(SEARCH_HYBRID=true)도 계약 형태로 top_k를 반환한다', async () => {
    const results = await engine({ SEARCH_HYBRID: 'true' }).search('주민신고제 단속', 3);
    expect(results).toHaveLength(3);
    expect(results[0].source).toBe('S-0002');
  });

  it('임베딩 차원이 EMBEDDING_DIM과 다르면 벡터 검색 대신 키워드 폴백', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    embedding.dim = 512;
    expect((await engine().search('쓰레기 무단투기', 3)).map((r) => r.source)).toEqual(['S-0003']);
    jest.restoreAllMocks();
  });
});

describe('시작 시 임베딩 점검', () => {
  const s = makeServices();
  const embedding = new KeywordEmbedding();
  const check = (over: Record<string, string> = {}) => new EmbeddingCheck(s.corpus, embedding, loadEnv({ ...process.env, ...over }));

  beforeEach(async () => {
    embedding.fail = false;
    embedding.dim = DIM;
    await resetDb(s.prisma);
  });
  afterAll(() => s.prisma.$disconnect());

  it('정상 설정이면 통과', async () => {
    await expect(check().onModuleInit()).resolves.toBeUndefined();
  });

  it('EMBEDDING_DIM이 DB 컬럼 차원과 다르면 시작 실패', async () => {
    await expect(check({ EMBEDDING_DIM: '768' }).onModuleInit()).rejects.toThrow(/DB 벡터 컬럼 차원\(1024\)/);
  });

  it('모델 출력 차원이 EMBEDDING_DIM과 다르면 시작 실패', async () => {
    embedding.dim = 768;
    await expect(check().onModuleInit()).rejects.toThrow(/출력 차원\(768\)/);
  });

  it('임베딩 서버에 연결할 수 없으면 경고만 하고 시작한다', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    embedding.fail = true;
    await expect(check().onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('키워드 매칭으로 폴백'));
    warn.mockRestore();
  });

  it('다른 모델로 임베딩된 항목이 있으면 재임베딩을 안내한다', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await s.prisma.$executeRaw`
      INSERT INTO corpus_entries (source, content, origin, embedding, embedding_model)
      VALUES ('S-0001', '내용', 'seed', ${pgvector.toSql((await embedding.embed(['x']))[0])}::vector, 'old-model')`;
    await check().onModuleInit();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/1건이 .*다른 모델.*\/dev\/corpus\/reembed/));
    warn.mockRestore();
  });
});
