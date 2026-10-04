import { Injectable } from '@nestjs/common';
import type { SearchResult } from '@minwon/contracts';
import pgvector from 'pgvector';
import { PrismaService, Tx } from '../prisma/prisma.service';

export interface NewSentEntry {
  complaintId: string;
  content: string;
  embedding: number[];
  embeddingModel: string;
}

/** 발송 답변의 source. 형식은 contracts의 SOURCE_REGEX를 따른다(uuid 36자 + 2자). */
export const sentSource = (complaintId: string): string => `A-${complaintId}`;

/** 하이브리드 점수 = 벡터 유사도 × VECTOR_WEIGHT + trigram 유사도 × TRGM_WEIGHT */
export const HYBRID_VECTOR_WEIGHT = 0.7;
export const HYBRID_TRGM_WEIGHT = 0.3;

/**
 * 근거 코퍼스 저장소. 벡터 SQL은 이 파일에만 둔다(backend-spec 5번, 벡터DB 교체 대비).
 * 다른 코드는 SearchEngine.search() 인터페이스만 쓴다.
 * 코퍼스에는 seed(개발자 시드)와 sent(발송 답변)만 있다 — draft·approved 후보는 들어올 경로가 없다.
 */
@Injectable()
export class CorpusRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 발송 답변 추가. 반드시 sent 전이와 같은 트랜잭션(tx) 안에서만 호출된다
   * — ComplaintStateService.transition(…, 'sent') 외에는 호출하지 말 것.
   */
  async insertSent(tx: Tx, entry: NewSentEntry): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO corpus_entries (source, content, origin, complaint_id, embedding, embedding_model)
      VALUES (${sentSource(entry.complaintId)}, ${entry.content}, 'sent', ${entry.complaintId}::uuid,
              ${pgvector.toSql(entry.embedding)}::vector, ${entry.embeddingModel})`;
  }

  /** 코사인 거리(<=>) 오름차순 top_k. HNSW(vector_cosine_ops) 인덱스를 탄다. */
  async searchByVector(embedding: number[], topK: number): Promise<SearchResult[]> {
    return this.prisma.$queryRaw<SearchResult[]>`
      SELECT source, content FROM corpus_entries
      ORDER BY embedding <=> ${pgvector.toSql(embedding)}::vector, id
      LIMIT ${topK}`;
  }

  /** 벡터 유사도 + pg_trgm 유사도 혼합 (SEARCH_HYBRID=true) */
  async searchHybrid(embedding: number[], query: string, topK: number): Promise<SearchResult[]> {
    return this.prisma.$queryRaw<SearchResult[]>`
      SELECT source, content FROM corpus_entries
      ORDER BY (${HYBRID_VECTOR_WEIGHT} * (1 - (embedding <=> ${pgvector.toSql(embedding)}::vector))
              + ${HYBRID_TRGM_WEIGHT} * similarity(content, ${query})) DESC, id
      LIMIT ${topK}`;
  }

  /** 임베딩 불가 시 폴백: 핵심어가 많이 포함된 순. 하나도 안 맞으면 빈 결과. */
  async searchByKeywords(keywords: string[], topK: number): Promise<SearchResult[]> {
    if (keywords.length === 0) return [];
    const patterns = keywords.map((k) => `%${k.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    return this.prisma.$queryRaw<SearchResult[]>`
      SELECT source, content FROM (
        SELECT id, source, content,
               (SELECT count(*) FROM unnest(${patterns}::text[]) AS p WHERE content ILIKE p) AS hits
        FROM corpus_entries
      ) scored
      WHERE hits > 0
      ORDER BY hits DESC, id
      LIMIT ${topK}`;
  }

  // ── 개발자 시드 (backend-spec 6-2) ───────────────────────────
  // 시드는 RDB 답변초안과 무관한 별도 입력이다. origin='sent' 항목은 이 경로로 바꾸거나 지우지 않는다.

  async findBySources(sources: string[]): Promise<{ source: string; origin: 'seed' | 'sent'; content: string }[]> {
    if (sources.length === 0) return [];
    return this.prisma.corpusEntry.findMany({
      where: { source: { in: sources } },
      select: { source: true, origin: true, content: true },
    });
  }

  /** 기존 S-#### 중 가장 큰 번호 (없으면 0) */
  async maxSeedNumber(): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ max: number | null }[]>`
      SELECT max(substring(source from '^S-([0-9]+)$')::int) AS max FROM corpus_entries`;
    return Number(row.max ?? 0);
  }

  /** 시드 추가·갱신. 같은 source의 sent 항목은 절대 덮어쓰지 않는다(WHERE origin='seed'). */
  async upsertSeed(tx: Tx, row: { source: string; content: string; embedding: number[]; embeddingModel: string }) {
    const n = await tx.$executeRaw`
      INSERT INTO corpus_entries (source, content, origin, embedding, embedding_model)
      VALUES (${row.source}, ${row.content}, 'seed', ${pgvector.toSql(row.embedding)}::vector, ${row.embeddingModel})
      ON CONFLICT (source) DO UPDATE
        SET content = EXCLUDED.content, embedding = EXCLUDED.embedding,
            embedding_model = EXCLUDED.embedding_model, updated_at = now()
        WHERE corpus_entries.origin = 'seed'`;
    if (n !== 1) throw new Error(`시드가 아닌 항목과 source가 겹칩니다: ${row.source}`);
  }

  /** mode=replace: origin='seed'만 지운다. 발송으로 쌓인 항목은 건드리지 않는다. */
  async deleteAllSeeds(tx: Tx): Promise<number> {
    return tx.$executeRaw`DELETE FROM corpus_entries WHERE origin = 'seed'`;
  }

  async deleteSeed(source: string): Promise<'deleted' | 'not_found' | 'not_seed'> {
    const n = await this.prisma.$executeRaw`DELETE FROM corpus_entries WHERE source = ${source} AND origin = 'seed'`;
    if (n === 1) return 'deleted';
    return (await this.prisma.corpusEntry.count({ where: { source } })) > 0 ? 'not_seed' : 'not_found';
  }

  async list(origin?: 'seed' | 'sent') {
    return this.prisma.corpusEntry.findMany({
      where: origin ? { origin } : {},
      select: { source: true, content: true, origin: true, embeddingModel: true, createdAt: true },
      orderBy: { id: 'asc' },
    });
  }

  /** 재임베딩: 내용은 그대로 두고 벡터와 모델명만 바꾼다 */
  async updateEmbedding(source: string, embedding: number[], embeddingModel: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE corpus_entries SET embedding = ${pgvector.toSql(embedding)}::vector,
             embedding_model = ${embeddingModel}, updated_at = now()
      WHERE source = ${source}`;
  }

  /** 마이그레이션에 고정된 embedding 컬럼의 차원 */
  async columnDimension(): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ dim: number }[]>`
      SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'corpus_entries'::regclass AND attname = 'embedding'`;
    return Number(row.dim);
  }

  /** 현재 EMBEDDING_MODEL과 다른 모델로 임베딩된 항목 수 */
  async countOtherModel(model: string): Promise<number> {
    return this.prisma.corpusEntry.count({ where: { NOT: { embeddingModel: model } } });
  }

  async count(): Promise<number> {
    return this.prisma.corpusEntry.count();
  }
}

/** 키워드 폴백용 핵심어: 공백·문장부호로 나눈 2자 이상 단어(중복 제거, 최대 30개) */
export function keywordsOf(query: string): string[] {
  const words = query.split(/[\s.,!?;:()[\]{}"'“”‘’·…~\-_/\\]+/u).filter((w) => w.length >= 2);
  return [...new Set(words)].slice(0, 30);
}
