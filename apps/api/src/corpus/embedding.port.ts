/** 임베딩 인터페이스(DI 토큰). 실제 구현(OpenAI 호환 /embeddings)은 3단계. 테스트는 고정 벡터로 대체한다. */
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export interface EmbeddingProvider {
  /** 저장 시 corpus_entries.embedding_model에 기록할 모델명 */
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
