-- 생성 실행에서 쓴 검색 결과(근거 원문 표시용, 데스크톱 화면 ②)
ALTER TABLE "generation_runs" ADD COLUMN "evidence" JSONB NOT NULL DEFAULT '[]';
