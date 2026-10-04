import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SearchEngine, SearchResult } from '@minwon/contracts';
import { ENV, type Env } from '../config/env';
import { CorpusRepository, keywordsOf } from '../corpus/corpus.repository';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../corpus/embedding.port';

/**
 * corpus_entries 대상 벡터 검색 (SEARCH_ENGINE=vector).
 * 임베딩 호출이 불가하면 키워드 매칭으로 폴백하고 경고를 남긴다(시그니처 동일).
 */
@Injectable()
export class VectorSearchEngine implements SearchEngine {
  private readonly logger = new Logger('Search');

  constructor(
    private readonly corpus: CorpusRepository,
    @Inject(EMBEDDING_PROVIDER) private readonly embedding: EmbeddingProvider,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async search(query: string, top_k: number): Promise<SearchResult[]> {
    let vector: number[] | undefined;
    try {
      [vector] = await this.embedding.embed([query]);
      if (vector?.length !== this.env.EMBEDDING_DIM) throw new Error(`차원 불일치(${vector?.length})`);
    } catch (e) {
      this.logger.warn(`임베딩 불가 → 키워드 매칭으로 폴백 (${e instanceof Error ? e.name : 'unknown'})`);
      return this.corpus.searchByKeywords(keywordsOf(query), top_k);
    }
    return this.env.SEARCH_HYBRID
      ? this.corpus.searchHybrid(vector, query, top_k)
      : this.corpus.searchByVector(vector, top_k);
  }
}
