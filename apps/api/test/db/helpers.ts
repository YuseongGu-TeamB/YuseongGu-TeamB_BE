import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Candidate } from '@minwon/contracts';
import { config } from 'dotenv';
import pgvector from 'pgvector';
import { ComplaintStateService } from '../../src/complaints/complaint-state.service';
import { SendService } from '../../src/complaints/send.service';
import { loadEnv } from '../../src/config/env';
import { CorpusRepository } from '../../src/corpus/corpus.repository';
import type { EmbeddingProvider } from '../../src/corpus/embedding.port';
import { PrismaService } from '../../src/prisma/prisma.service';

config({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://app:app@localhost:5433/minwon_test';
// 테스트는 개인 .env의 LLM 설정(시연용 클라우드 등)과 무관하게 같은 결과를 내야 한다. LLM 호출 자체는 가짜로 바꾼다.
process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
process.env.OPENAI_API_KEY = 'ollama';
process.env.MODEL = 'qwen2.5:7b';
delete process.env.LLM_EXTRA_BODY;
delete process.env.OLLAMA_OPTIONS;

export const DIM = 1024;
export const fixedVector = (seed = 1): number[] => Array.from({ length: DIM }, (_, i) => ((i * seed) % 7) / 7 + 0.01);

/** 고정 벡터를 돌려주는 임베딩 mock. fail=true면 예외. */
export class FakeEmbedding implements EmbeddingProvider {
  readonly model = 'fake-embed';
  fail = false;
  /** 이 문자열이 들어간 텍스트가 포함되면 그 호출은 실패 */
  failOn?: string;
  calls: string[][] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    if (this.fail) throw new Error('embedding server down');
    if (this.failOn && texts.some((t) => t.includes(this.failOn!))) throw new Error('embedding failed');
    return texts.map(() => fixedVector());
  }
}

export function makeServices() {
  const prisma = new PrismaService();
  const corpus = new CorpusRepository(prisma);
  const state = new ComplaintStateService(prisma, corpus);
  const embedding = new FakeEmbedding();
  const env = loadEnv();
  const send = new SendService(prisma, state, embedding, env);
  return { prisma, corpus, state, embedding, send, env };
}

export async function resetDb(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE corpus_entries, drafts, generation_runs, complaints RESTART IDENTITY CASCADE',
  );
}

export const candidates = (...answers: string[]): Candidate[] =>
  answers.map((answer, i) => ({
    answer,
    approach: (['PROCEDURE_GUIDE', 'ONSITE_CHECK', 'IMMEDIATE_ACTION'] as const)[i % 3],
    used_sources: [],
    assumptions: [],
  }));

type Services = ReturnType<typeof makeServices>;

/** 접수 → (생성 실행 기록) → draft. 상태 변경은 transition()만 사용한다. */
export async function createDraft(s: Services, answers: string[]) {
  const complaint = await s.prisma.complaint.create({ data: { content: '합성 민원: 불법주정차 단속 요청' } });
  await regenerate(s, complaint.id, answers);
  return complaint;
}

export async function regenerate(s: Services, complaintId: string, answers: string[]) {
  const run = await s.prisma.generationRun.create({ data: { complaintId, model: 'test-model', status: 'done' } });
  await s.state.transition(complaintId, { to: 'draft', runId: run.id, model: 'test-model', drafts: candidates(...answers).map((candidate) => ({ id: randomUUID(), candidate })) });
  return run;
}

/** PATCH /drafts/:id 의 선택·수정에 해당 (상태 변경 아님) */
export async function selectDraft(s: Services, complaintId: string, approach: string, editedAnswer?: string) {
  const draft = await s.prisma.draft.findFirstOrThrow({
    where: { complaintId, superseded: false, approach: approach as never },
  });
  await s.prisma.draft.update({ where: { id: draft.id }, data: { selected: true, editedAnswer } });
  return draft;
}

export async function insertSeed(s: Services, source: string, content: string) {
  await s.prisma.$executeRaw`
    INSERT INTO corpus_entries (source, content, origin, embedding, embedding_model)
    VALUES (${source}, ${content}, 'seed', ${pgvector.toSql(fixedVector(2))}::vector, 'fake-embed')`;
}

export const corpusContents = async (s: Services) =>
  (await s.prisma.corpusEntry.findMany({ select: { content: true } })).map((r) => r.content);
