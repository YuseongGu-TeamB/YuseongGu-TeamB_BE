/**
 * 변경 금지 계약 (backend-spec 2번, architecture 3번).
 *
 * 필드명 변경·추가·삭제 금지. api와 desktop은 이 패키지만 import한다.
 * 이 파일을 바꾸면 test/contracts.spec.ts의 스냅샷이 실패한다 — 의도한 변경일 때만 갱신할 것.
 */
import { z } from 'zod';

// ── 공통 ────────────────────────────────────────────────

/** 코퍼스 항목의 고유 문자열. 영문·숫자·`-`·`_`, 최대 50자. 시드 `S-0001`, 발송 답변 `A-<민원 id>`. */
export const SOURCE_REGEX = /^[A-Za-z0-9_-]{1,50}$/;
export const SourceSchema = z.string().regex(SOURCE_REGEX);

export const APPROACHES = ['PROCEDURE_GUIDE', 'ONSITE_CHECK', 'IMMEDIATE_ACTION', 'NOT_ELIGIBLE'] as const;
export const ApproachSchema = z.enum(APPROACHES);
export type Approach = z.infer<typeof ApproachSchema>;

/** 민원 상태. received → draft → approved → sent 순서만 허용(전이 규칙은 api의 상태 머신). */
export const STATUSES = ['received', 'draft', 'approved', 'sent'] as const;
export const StatusSchema = z.enum(STATUSES);
export type Status = z.infer<typeof StatusSchema>;

// ── 검색 계약 ───────────────────────────────────────────

export const SearchResultSchema = z.strictObject({
  content: z.string(),
  source: SourceSchema,
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

/** search(query, top_k) → [{ content, source }, ...]. 파라미터 이름·순서 변경 금지. */
export interface SearchEngine {
  search(query: string, top_k: number): Promise<SearchResult[]>;
}

// ── 생성 출력 계약 ───────────────────────────────────────

/** 답변 후보 1개 (생성 출력 고정 JSON). */
export const CandidateSchema = z.strictObject({
  answer: z.string(),
  approach: ApproachSchema,
  used_sources: z.array(SourceSchema),
  assumptions: z.array(z.string()),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** 생성 결과. */
export const GenerateResponseSchema = z.strictObject({
  candidates: z.array(CandidateSchema),
  is_info_sufficient: z.boolean(),
  insufficient_reason: z.string().nullable().optional(),
});
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

// ── API 봉투 (계약 밖 정보는 여기에만) ────────────────────

export const GenerateApiResponseSchema = z.strictObject({
  complaint_id: z.string(),
  status: StatusSchema,
  /** 이번 생성에 쓴 모델 */
  model: z.string(),
  /** 계약 그대로 */
  result: GenerateResponseSchema,
  /** 후보와 같은 순서, PATCH용 id */
  drafts: z.array(z.strictObject({ draft_id: z.string(), approach: ApproachSchema })),
  /** 생성 실패 후보 */
  failed: z.array(z.strictObject({ approach: ApproachSchema, reason: z.string() })),
  timings: z.array(z.strictObject({ stage: z.string(), ms: z.number(), tokens: z.number().optional() })),
  /** 이 실행에서 쓴 검색 결과(근거 원문 표시용). 검색 계약 형태 그대로 */
  evidence: z.array(SearchResultSchema),
});
export type GenerateApiResponse = z.infer<typeof GenerateApiResponseSchema>;

// ── API 응답 (계약 밖, api와 desktop이 함께 쓰는 형태를 한 곳에서 정의) ──────

/** POST /complaints/quick, POST /complaints/:id/generate → 202 */
export const GenerateAcceptedSchema = z.strictObject({
  complaint_id: z.string(),
  run_id: z.string(),
});
export type GenerateAccepted = z.infer<typeof GenerateAcceptedSchema>;

/** 답변 후보 1개의 화면용 형태(PATCH /drafts/:id 응답, GET /complaints/:id의 drafts) */
export const DraftViewSchema = z.strictObject({
  draft_id: z.string(),
  approach: ApproachSchema,
  answer: z.string(),
  used_sources: z.array(SourceSchema),
  assumptions: z.array(z.string()),
  edited_answer: z.string().nullable(),
  selected: z.boolean(),
  model: z.string(),
});
export type DraftView = z.infer<typeof DraftViewSchema>;

export const RunStatusSchema = z.enum(['running', 'done', 'error']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** GET /complaints/:id (및 POST /complaints, approve, send 응답) */
export const ComplaintViewSchema = z.strictObject({
  complaint_id: z.string(),
  content: z.string(),
  status: StatusSchema,
  created_at: z.string(),
  /** 현재 후보(superseded 제외), 생성 순서대로 */
  drafts: z.array(DraftViewSchema),
  /** 최신 생성 실행. 없으면 null */
  generation: z
    .strictObject({
      run_id: z.string(),
      status: RunStatusSchema,
      model: z.string(),
      started_at: z.string(),
      finished_at: z.string().nullable(),
      error: z.string().nullable(),
      result: GenerateApiResponseSchema.nullable(),
    })
    .nullable(),
});
export type ComplaintView = z.infer<typeof ComplaintViewSchema>;

export const HealthComponentSchema = z.strictObject({
  ok: z.boolean(),
  /** 호스트가 loopback/사설 IP인가 */
  local: z.boolean(),
  host: z.string(),
  required_local: z.boolean(),
  model: z.string().optional(),
  error: z.string().optional(),
});
export type HealthComponent = z.infer<typeof HealthComponentSchema>;

/** GET /health */
export const HealthSchema = z.strictObject({
  status: z.enum(['ok', 'degraded']),
  search_engine: z.enum(['mock', 'vector']),
  components: z.strictObject({ db: HealthComponentSchema, llm: HealthComponentSchema, embedding: HealthComponentSchema }),
});
export type Health = z.infer<typeof HealthSchema>;
