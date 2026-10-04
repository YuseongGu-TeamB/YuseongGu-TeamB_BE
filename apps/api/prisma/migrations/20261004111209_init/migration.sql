-- pgvector 확장 (corpus_entries.embedding)
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('received', 'draft', 'approved', 'sent');

-- CreateEnum
CREATE TYPE "Approach" AS ENUM ('PROCEDURE_GUIDE', 'ONSITE_CHECK', 'IMMEDIATE_ACTION', 'NOT_ELIGIBLE');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('running', 'done', 'error');

-- CreateEnum
CREATE TYPE "CorpusOrigin" AS ENUM ('seed', 'sent');

-- CreateTable
CREATE TABLE "complaints" (
    "id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'received',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_runs" (
    "id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'running',
    "is_info_sufficient" BOOLEAN,
    "insufficient_reason" TEXT,
    "failed" JSONB NOT NULL DEFAULT '[]',
    "timings" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "generation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drafts" (
    "id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "approach" "Approach" NOT NULL,
    "answer" TEXT NOT NULL,
    "used_sources" TEXT[],
    "assumptions" TEXT[],
    "edited_answer" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "superseded" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corpus_entries" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "origin" "CorpusOrigin" NOT NULL,
    "complaint_id" UUID,
    "embedding" vector(1024) NOT NULL,
    "embedding_model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corpus_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_runs_complaint_id_started_at_idx" ON "generation_runs"("complaint_id", "started_at");

-- CreateIndex
CREATE INDEX "drafts_complaint_id_idx" ON "drafts"("complaint_id");

-- CreateIndex
CREATE UNIQUE INDEX "corpus_entries_source_key" ON "corpus_entries"("source");

-- CreateIndex
CREATE UNIQUE INDEX "corpus_entries_complaint_id_key" ON "corpus_entries"("complaint_id");

-- AddForeignKey
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_complaint_id_fkey" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_complaint_id_fkey" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "generation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 아래는 schema.prisma로 표현할 수 없어 직접 추가한 것 ──────────────
-- 주의: 이후 `prisma migrate dev`가 아래 인덱스를 DROP하는 SQL을 만들면 그 줄은 지우고 적용할 것.

-- 코사인 거리 검색용 HNSW 인덱스 (backend-spec 5번)
CREATE INDEX "corpus_entries_embedding_hnsw_idx" ON "corpus_entries" USING hnsw ("embedding" vector_cosine_ops);

-- 선택은 민원당 1개 (backend-spec 6번 PATCH /drafts/:id)
CREATE UNIQUE INDEX "drafts_one_selected_per_complaint" ON "drafts"("complaint_id") WHERE "selected";

-- source 형식: 영문·숫자·-·_, 최대 50자 (backend-spec 2번)
ALTER TABLE "corpus_entries" ADD CONSTRAINT "corpus_entries_source_format" CHECK ("source" ~ '^[A-Za-z0-9_-]{1,50}$');

-- 발송 항목은 원 민원을 반드시 가리키고, 시드는 민원과 무관하다
ALTER TABLE "corpus_entries" ADD CONSTRAINT "corpus_entries_origin_complaint" CHECK (("origin" = 'sent') = ("complaint_id" IS NOT NULL));
