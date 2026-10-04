import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { MockSearchEngine } from './mock-search.engine';
import { SEARCH_ENGINE } from './search.port';

@Module({
  providers: [
    MockSearchEngine,
    {
      provide: SEARCH_ENGINE,
      inject: [ENV, MockSearchEngine],
      useFactory: (env: Env, mock: MockSearchEngine) => {
        if (env.SEARCH_ENGINE === 'mock') return mock;
        // vector 구현은 3단계(임베딩 + pgvector 검색)에서 추가
        throw new Error('SEARCH_ENGINE=vector 는 아직 구현되지 않았습니다. 지금은 SEARCH_ENGINE=mock 으로 실행하세요.');
      },
    },
  ],
  exports: [SEARCH_ENGINE],
})
export class SearchModule {}
