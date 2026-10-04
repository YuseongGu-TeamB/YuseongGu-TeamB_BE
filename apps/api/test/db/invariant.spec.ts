import { ComplaintStateService } from '../../src/complaints/complaint-state.service';
import { EmbeddingFailedError, TransitionPreconditionError } from '../../src/complaints/errors';
import { InvalidTransitionError } from '../../src/complaints/state-machine';
import { sentSource } from '../../src/corpus/corpus.repository';
import {
  corpusContents,
  createDraft,
  insertSeed,
  makeServices,
  regenerate,
  resetDb,
  selectDraft,
} from './helpers';

/**
 * 핵심 불변식(backend-spec 3번, architecture 3-3번):
 * 검색 코퍼스에는 sent 전이 시점에만, 담당자 최종본만 추가된다.
 * draft·approved·미선택·superseded 후보는 어떤 경로로도 들어가지 않는다.
 */
describe('불변식: sent 시점에만 코퍼스 추가', () => {
  const s = makeServices();

  beforeEach(async () => {
    s.embedding.fail = false;
    s.embedding.calls = [];
    await resetDb(s.prisma);
  });
  afterAll(() => s.prisma.$disconnect());

  const statusOf = async (id: string) => (await s.prisma.complaint.findUniqueOrThrow({ where: { id } })).status;

  it('received·draft·재생성·approved 동안 코퍼스는 늘지 않고, sent 후 최종본 1건만 추가된다', async () => {
    const c = await createDraft(s, ['1차 절차 안내', '1차 현장 확인']);
    expect(await s.corpus.count()).toBe(0);

    await regenerate(s, c.id, ['2차 절차 안내', '2차 현장 확인', '2차 즉시 조치']);
    expect(await statusOf(c.id)).toBe('draft');
    expect(await s.corpus.count()).toBe(0);

    await selectDraft(s, c.id, 'ONSITE_CHECK', '담당자가 수정한 최종 답변');
    await s.state.transition(c.id, { to: 'approved' });
    expect(await statusOf(c.id)).toBe('approved');
    expect(await s.corpus.count()).toBe(0);

    await s.send.send(c.id);
    expect(await statusOf(c.id)).toBe('sent');

    const entries = await s.prisma.corpusEntry.findMany();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: sentSource(c.id),
      content: '담당자가 수정한 최종 답변',
      origin: 'sent',
      complaintId: c.id,
      embeddingModel: 'fake-embed',
    });
    // 임베딩한 텍스트도 최종본이다
    expect(s.embedding.calls).toEqual([['담당자가 수정한 최종 답변']]);
  });

  it('미선택·superseded 후보와 수정 전 원문은 코퍼스에 들어가지 않는다', async () => {
    const c = await createDraft(s, ['옛 후보 A', '옛 후보 B']);
    await selectDraft(s, c.id, 'PROCEDURE_GUIDE'); // 재생성 전 선택 → superseded되며 선택 해제
    await regenerate(s, c.id, ['새 후보 A', '새 후보 B']);
    await selectDraft(s, c.id, 'PROCEDURE_GUIDE', '최종본');
    await s.state.transition(c.id, { to: 'approved' });
    await s.send.send(c.id);

    expect(await corpusContents(s)).toEqual(['최종본']);
    const old = await s.prisma.draft.findMany({ where: { complaintId: c.id, superseded: true } });
    expect(old).toHaveLength(2);
    expect(old.every((d) => !d.selected)).toBe(true);
  });

  it('수정하지 않았으면 선택한 후보의 answer가 그대로 들어간다', async () => {
    const c = await createDraft(s, ['원문 그대로 발송', '다른 후보']);
    await selectDraft(s, c.id, 'PROCEDURE_GUIDE');
    await s.state.transition(c.id, { to: 'approved' });
    await s.send.send(c.id);
    expect(await corpusContents(s)).toEqual(['원문 그대로 발송']);
  });

  it('임베딩 실패 시 sent로 전이하지 않고 코퍼스도 그대로다', async () => {
    const c = await createDraft(s, ['답변']);
    await selectDraft(s, c.id, 'PROCEDURE_GUIDE');
    await s.state.transition(c.id, { to: 'approved' });

    s.embedding.fail = true;
    await expect(s.send.send(c.id)).rejects.toThrow(EmbeddingFailedError);
    expect(await statusOf(c.id)).toBe('approved');
    expect(await s.corpus.count()).toBe(0);
  });

  it('코퍼스 추가가 실패하면 sent 전이도 롤백된다(같은 트랜잭션)', async () => {
    const c = await createDraft(s, ['답변']);
    await selectDraft(s, c.id, 'PROCEDURE_GUIDE');
    await s.state.transition(c.id, { to: 'approved' });
    // 같은 source를 시드가 이미 쓰고 있으면 INSERT가 유니크 위반으로 실패한다
    await insertSeed(s, sentSource(c.id), '시드');

    await expect(s.send.send(c.id)).rejects.toThrow();
    expect(await statusOf(c.id)).toBe('approved');
    expect(await corpusContents(s)).toEqual(['시드']);
  });

  it('draft 상태에서 발송하면 거부되고 임베딩도 호출하지 않는다', async () => {
    const c = await createDraft(s, ['답변']);
    await selectDraft(s, c.id, 'PROCEDURE_GUIDE');
    await expect(s.send.send(c.id)).rejects.toThrow(InvalidTransitionError);
    expect(s.embedding.calls).toHaveLength(0);
    expect(await s.corpus.count()).toBe(0);
  });

  it('transition()을 직접 불러도 draft → sent는 거부된다', async () => {
    const c = await createDraft(s, ['답변']);
    await selectDraft(s, c.id, 'PROCEDURE_GUIDE');
    await expect(
      s.state.transition(c.id, { to: 'sent', content: '답변', embedding: [0.1], embeddingModel: 'x' }),
    ).rejects.toThrow(InvalidTransitionError);
    expect(await statusOf(c.id)).toBe('draft');
    expect(await s.corpus.count()).toBe(0);
  });

  it('이미 sent인 민원은 다시 발송·재생성할 수 없다', async () => {
    const c = await createDraft(s, ['답변']);
    await selectDraft(s, c.id, 'PROCEDURE_GUIDE');
    await s.state.transition(c.id, { to: 'approved' });
    await s.send.send(c.id);

    await expect(s.send.send(c.id)).rejects.toThrow(InvalidTransitionError);
    await expect(regenerate(s, c.id, ['새 답변'])).rejects.toThrow(InvalidTransitionError);
    expect(await s.corpus.count()).toBe(1);
  });

  it('동시에 두 번 발송해도 코퍼스에는 1건만 들어간다', async () => {
    const c = await createDraft(s, ['답변']);
    await selectDraft(s, c.id, 'PROCEDURE_GUIDE');
    await s.state.transition(c.id, { to: 'approved' });

    const results = await Promise.allSettled([s.send.send(c.id), s.send.send(c.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await statusOf(c.id)).toBe('sent');
    expect(await s.corpus.count()).toBe(1);
  });

  it('임베딩 후 최종본이 바뀌었으면 발송을 거부한다', async () => {
    const c = await createDraft(s, ['답변']);
    await selectDraft(s, c.id, 'PROCEDURE_GUIDE');
    await s.state.transition(c.id, { to: 'approved' });
    await expect(
      s.state.transition(c.id, { to: 'sent', content: '다른 내용', embedding: [0.1], embeddingModel: 'x' }),
    ).rejects.toThrow(TransitionPreconditionError);
    expect(await statusOf(c.id)).toBe('approved');
    expect(await s.corpus.count()).toBe(0);
  });
});

describe('상태 전이 전제 조건 (DB)', () => {
  const s = makeServices();

  beforeEach(async () => {
    s.embedding.fail = false;
    s.embedding.calls = [];
    await resetDb(s.prisma);
  });
  afterAll(() => s.prisma.$disconnect());

  it('선택된 후보 없이 승인할 수 없다', async () => {
    const c = await createDraft(s, ['답변']);
    await expect(s.state.transition(c.id, { to: 'approved' })).rejects.toThrow(TransitionPreconditionError);
  });

  it('received에서 바로 approved로 갈 수 없다', async () => {
    const c = await s.prisma.complaint.create({ data: { content: '합성 민원' } });
    await expect(s.state.transition(c.id, { to: 'approved' })).rejects.toThrow(InvalidTransitionError);
  });

  it('후보 0개로 draft가 되지 않는다', async () => {
    const c = await s.prisma.complaint.create({ data: { content: '합성 민원' } });
    await expect(regenerate(s, c.id, [])).rejects.toThrow(TransitionPreconditionError);
    expect((await s.prisma.complaint.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('received');
  });

  it('민원당 선택은 1개만 가능하다(DB 부분 유니크 인덱스)', async () => {
    const c = await createDraft(s, ['A', 'B']);
    await selectDraft(s, c.id, 'PROCEDURE_GUIDE');
    await expect(selectDraft(s, c.id, 'ONSITE_CHECK')).rejects.toThrow();
  });

  it('상태 변경은 ComplaintStateService, 코퍼스 쓰기는 CorpusRepository에만 있다', () => {
    // 다른 서비스가 complaints.status를 직접 바꾸지 않는지 소스 수준에서 확인
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const srcDir = path.resolve(__dirname, '../../src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) {
          if (f.name !== 'generated') walk(p);
        } else if (p.endsWith('.ts')) {
          const code = fs.readFileSync(p, 'utf8');
          const rel = path.relative(srcDir, p);
          const changesStatus = /complaint\.(update|updateMany|upsert)\s*\(/.test(code) || /UPDATE\s+complaints/i.test(code);
          if (changesStatus && !p.endsWith('complaint-state.service.ts')) offenders.push(`상태 변경: ${rel}`);
          // 코퍼스 쓰기(벡터 SQL)도 CorpusRepository 한 곳에만
          const writesCorpus = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+corpus_entries/i.test(code);
          if (writesCorpus && !p.endsWith('corpus.repository.ts')) offenders.push(`코퍼스 쓰기: ${rel}`);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
    expect(ComplaintStateService.prototype.transition).toBeDefined();
  });
});
