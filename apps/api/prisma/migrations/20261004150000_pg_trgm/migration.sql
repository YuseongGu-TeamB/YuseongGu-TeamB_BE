-- 하이브리드 검색(SEARCH_HYBRID=true)용 trigram 유사도 (backend-spec 5번)
-- 주의: schema.prisma로 표현할 수 없는 인덱스다. 이후 `prisma migrate dev`가 이 인덱스를 DROP하는 SQL을 만들면 그 줄은 지울 것.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "corpus_entries_content_trgm_idx" ON "corpus_entries" USING gin ("content" gin_trgm_ops);
