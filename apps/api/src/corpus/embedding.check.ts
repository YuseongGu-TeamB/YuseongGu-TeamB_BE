import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { CorpusRepository } from './corpus.repository';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding.port';

/**
 * 시작 시 임베딩 설정 점검 (backend-spec 5번)
 *  - EMBEDDING_DIM ≠ DB 컬럼 차원 또는 실제 모델 출력 차원 → 에러로 중단
 *  - 임베딩 서버 연결 불가 → 경고(검색은 키워드 폴백, 발송은 실패한다)
 *  - 현재 EMBEDDING_MODEL과 다른 모델로 임베딩된 항목 → 경고(재임베딩 안내)
 */
@Injectable()
export class EmbeddingCheck implements OnModuleInit {
  private readonly logger = new Logger('Embedding');

  constructor(
    private readonly corpus: CorpusRepository,
    @Inject(EMBEDDING_PROVIDER) private readonly embedding: EmbeddingProvider,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    const columnDim = await this.corpus.columnDimension();
    if (columnDim !== this.env.EMBEDDING_DIM) {
      throw new Error(
        `EMBEDDING_DIM(${this.env.EMBEDDING_DIM})이 DB 벡터 컬럼 차원(${columnDim})과 다릅니다. 임베딩 모델을 바꿨다면 마이그레이션으로 컬럼 차원을 맞춰야 합니다.`,
      );
    }

    let actual: number | undefined;
    try {
      [actual] = (await this.embedding.embed(['임베딩 차원 확인'])).map((v) => v.length);
    } catch (e) {
      this.logger.warn(
        `임베딩 서버(${this.env.EMBEDDING_BASE_URL}, ${this.env.EMBEDDING_MODEL})에 연결할 수 없습니다. ` +
          `검색은 키워드 매칭으로 폴백하고, 발송은 실패합니다. (${e instanceof Error ? e.name : 'unknown'})`,
      );
    }
    if (actual !== undefined && actual !== this.env.EMBEDDING_DIM) {
      throw new Error(
        `임베딩 모델 ${this.env.EMBEDDING_MODEL}의 출력 차원(${actual})이 EMBEDDING_DIM(${this.env.EMBEDDING_DIM})과 다릅니다.`,
      );
    }

    const stale = await this.corpus.countOtherModel(this.env.EMBEDDING_MODEL);
    if (stale > 0) {
      this.logger.warn(
        `코퍼스 ${stale}건이 현재 EMBEDDING_MODEL(${this.env.EMBEDDING_MODEL})과 다른 모델로 임베딩돼 있습니다. ` +
          `POST /dev/corpus/reembed 로 재임베딩하세요.`,
      );
    }
  }
}
