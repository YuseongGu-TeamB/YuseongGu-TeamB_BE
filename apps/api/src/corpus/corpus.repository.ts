import { Injectable } from '@nestjs/common';
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

/**
 * 근거 코퍼스 저장소. 벡터 SQL은 이 파일에만 둔다(backend-spec 5번).
 * 다른 코드는 search() 인터페이스만 쓴다. 검색·시드 쓰기는 3·4단계에서 추가.
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

  async count(): Promise<number> {
    return this.prisma.corpusEntry.count();
  }
}
