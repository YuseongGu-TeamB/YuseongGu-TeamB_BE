import { Module } from '@nestjs/common';
import { CorpusRepository } from './corpus.repository';
import { EMBEDDING_PROVIDER } from './embedding.port';
import { OpenAiEmbeddingProvider } from './openai-embedding.provider';

@Module({
  providers: [CorpusRepository, { provide: EMBEDDING_PROVIDER, useClass: OpenAiEmbeddingProvider }],
  exports: [CorpusRepository, EMBEDDING_PROVIDER],
})
export class CorpusModule {}
