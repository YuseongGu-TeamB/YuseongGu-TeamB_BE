import { Inject, Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { ENV, type Env } from '../config/env';
import type { EmbeddingProvider } from './embedding.port';

/**
 * OpenAI 호환 /embeddings 호출. 엔드포인트는 EMBEDDING_BASE_URL — LLM(OPENAI_BASE_URL)과 별도이며 로컬에 둔다.
 * 키는 로컬 ollama용 고정값을 쓴다(LLM용 클라우드 키를 임베딩 서버로 보내지 않는다).
 */
@Injectable()
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly client: OpenAI;

  constructor(@Inject(ENV) env: Env) {
    this.model = env.EMBEDDING_MODEL;
    this.client = new OpenAI({ baseURL: env.EMBEDDING_BASE_URL, apiKey: 'ollama', timeout: 60_000, maxRetries: 0 });
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.client.embeddings.create({ model: this.model, input: texts });
    return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
