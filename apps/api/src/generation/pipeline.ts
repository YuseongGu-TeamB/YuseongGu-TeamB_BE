import { Inject, Injectable } from '@nestjs/common';
import {
  ApproachSchema,
  CandidateSchema,
  type Approach,
  type Candidate,
  type GenerateResponse,
  type SearchEngine,
  type SearchResult,
} from '@minwon/contracts';
import { z } from 'zod';
import { ENV, type Env } from '../config/env';
import { SEARCH_ENGINE } from '../search/search.port';
import { StructuredLlm } from './llm.client';
import { stageLabel } from './llm.errors';
import * as P from './prompts';

export type Timing = {
  stage: string;
  ms: number;
  tokens?: number;
};

/** 파이프라인 진행 이벤트. 러너가 run_id·model을 붙여 SSE로 내보낸다. */
export type PipelineEvent =
  | { type: 'stage_started'; stage: string }
  | { type: 'stage_completed'; stage: string; ms: number; tokens?: number }
  | { type: 'candidate_completed'; approach: Approach; ms: number; tokens?: number }
  | { type: 'candidate_failed'; approach: Approach; reason: string };

export interface PipelineResult {
  result: GenerateResponse;
  failed: { approach: Approach; reason: string }[];
  timings: Timing[];
}

/** 근거 enum 제한을 zod로도 검증한다(서버가 json_schema를 강제하지 않는 경우 대비). */
export function sourcesValidator(sources: string[]) {
  return sources.length > 0 ? z.array(z.enum(sources as [string, ...string[]])) : z.array(z.string()).max(0);
}

export const AnalysisValidator = z.object({
  request_summary: z.string(),
  missing_info: z.array(z.string()),
  is_answerable: z.boolean(),
});
export type Analysis = z.infer<typeof AnalysisValidator>;

export const selectionValidator = (sources: string[]) =>
  z.object({
    selected_sources: sourcesValidator(sources),
    approaches: z.array(ApproachSchema).max(3),
  });
export type Selection = { selected_sources: string[]; approaches: Approach[] };

/** 답변 작성 출력 검증. approach는 지정한 접근 유형과 같아야 한다. 결과는 계약 Candidate. */
export const candidateValidator = (sources: string[], approach: Approach) =>
  z
    .object({
      answer: z.string().trim().min(1),
      approach: z.literal(approach),
      used_sources: sourcesValidator(sources),
      assumptions: z.array(z.string()),
    })
    .transform((v): Candidate => CandidateSchema.parse(v));

/**
 * 생성 파이프라인 (architecture ②~⑤, backend-spec 4번)
 *   1. 검색 → 2. 분석 → 3. 근거 선별 + 접근 결정 → 4. 접근 유형별 답변 작성(병렬, LLM_CONCURRENCY 한도)
 *   4단계에는 3단계에서 선별한 근거만 넘긴다(선별된 것이 없으면 근거 없이 작성, used_sources는 빈 배열).
 * 지연이 측정되면 2·3단계를 한 호출로 합칠 수 있도록 단계를 함수로 나눠 둔다(미리 합치지 않는다).
 */
@Injectable()
export class GenerationPipeline {
  constructor(
    private readonly llm: StructuredLlm,
    @Inject(SEARCH_ENGINE) private readonly searchEngine: SearchEngine,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async run(complaint: string, model: string, emit: (e: PipelineEvent) => void = () => undefined): Promise<PipelineResult> {
    const timings: Timing[] = [];
    const stage = async <T>(name: string, fn: () => Promise<{ value: T; ms: number; tokens?: number }>) => {
      emit({ type: 'stage_started', stage: name });
      const r = await fn();
      timings.push({ stage: name, ms: r.ms, ...(r.tokens !== undefined && { tokens: r.tokens }) });
      emit({ type: 'stage_completed', stage: name, ms: r.ms, ...(r.tokens !== undefined && { tokens: r.tokens }) });
      return r.value;
    };

    const results = await stage('search', () => this.search(complaint));
    const sources = results.map((r) => r.source);
    const context = P.formatContext(results);

    const analysis = await stage('analyze', () => this.analyze(complaint, context, model));
    const selection = await stage('select', () => this.select(complaint, context, analysis, sources, model));
    const approaches = selection.approaches.length > 0 ? [...new Set(selection.approaches)] : (['PROCEDURE_GUIDE'] as Approach[]);

    // 답변 작성에는 3단계에서 선별한 근거만 넘긴다. used_sources도 선별된 source 안에서만 허용된다.
    const selected = results.filter((r) => selection.selected_sources.includes(r.source));
    const selectedSources = selected.map((r) => r.source);
    const selectedContext = P.formatContext(selected);

    const failed: PipelineResult['failed'] = [];
    const written = await mapLimit(approaches, this.env.LLM_CONCURRENCY, async (approach) => {
      const name = `write:${approach}`;
      emit({ type: 'stage_started', stage: name });
      try {
        const r = await this.write(complaint, selectedContext, approach, analysis.request_summary, selectedSources, model);
        timings.push({ stage: name, ms: r.ms, ...(r.tokens !== undefined && { tokens: r.tokens }) });
        emit({ type: 'candidate_completed', approach, ms: r.ms, ...(r.tokens !== undefined && { tokens: r.tokens }) });
        return r.value;
      } catch (e) {
        const reason = e instanceof Error ? e.message : `${stageLabel(name)} 실패`;
        failed.push({ approach, reason });
        emit({ type: 'candidate_failed', approach, reason });
        return null;
      }
    });

    const candidates = written.filter((c): c is Candidate => c !== null);
    return {
      result: {
        candidates,
        is_info_sufficient: analysis.is_answerable,
        insufficient_reason: analysis.missing_info.length > 0 ? analysis.missing_info.join('; ') : null,
      },
      failed,
      timings,
    };
  }

  /** 1. 검색: 민원 원문으로 search(query, top_k) */
  async search(complaint: string) {
    const t0 = Date.now();
    const value: SearchResult[] = await this.searchEngine.search(complaint, this.env.SEARCH_TOP_K);
    return { value, ms: Date.now() - t0 };
  }

  /** 2. 분석: is_answerable, missing_info, request_summary */
  async analyze(complaint: string, context: string, model: string) {
    const r = await this.llm.call({
      stage: 'analyze',
      model,
      system: P.STAGE1_SYSTEM,
      user: P.stage1User(complaint, context),
      schema: P.STAGE1_SCHEMA,
      validator: AnalysisValidator,
    });
    return { value: r.data, ms: r.ms, tokens: r.tokens };
  }

  /** 3. 근거 선별 + 접근 유형 1~3개 결정 */
  async select(complaint: string, context: string, analysis: Analysis, sources: string[], model: string) {
    const r = await this.llm.call({
      stage: 'select',
      model,
      system: P.STAGE2_SYSTEM,
      user: P.stage2User(complaint, context, analysis.request_summary),
      schema: P.stage2Schema(sources),
      validator: selectionValidator(sources),
    });
    return { value: r.data as Selection, ms: r.ms, tokens: r.tokens };
  }

  /** 4. 접근 유형 1개에 대한 답변 작성 → 후보 1개 */
  async write(complaint: string, context: string, approach: Approach, summary: string, sources: string[], model: string) {
    const r = await this.llm.call({
      stage: `write:${approach}`,
      model,
      system: P.STAGE3_SYSTEM,
      user: P.stage3User(complaint, context, approach, summary),
      schema: P.stage3Schema(sources),
      validator: candidateValidator(sources, approach),
    });
    return { value: r.data, ms: r.ms, tokens: r.tokens };
  }
}

/** 입력 순서를 유지하며 동시 실행 수를 limit 이하로 제한한다. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
