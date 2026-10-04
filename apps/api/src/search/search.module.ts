import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { CorpusModule } from '../corpus/corpus.module';
import { MockSearchEngine } from './mock-search.engine';
import { SEARCH_ENGINE } from './search.port';
import { VectorSearchEngine } from './vector-search.engine';

@Module({
  imports: [CorpusModule],
  providers: [
    MockSearchEngine,
    VectorSearchEngine,
    {
      provide: SEARCH_ENGINE,
      inject: [ENV, MockSearchEngine, VectorSearchEngine],
      useFactory: (env: Env, mock: MockSearchEngine, vector: VectorSearchEngine) =>
        env.SEARCH_ENGINE === 'mock' ? mock : vector,
    },
  ],
  exports: [SEARCH_ENGINE],
})
export class SearchModule {}
