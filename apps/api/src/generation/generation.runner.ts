import { randomUUID } from 'node:crypto';
import type { GenerateAccepted } from '@minwon/contracts';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ComplaintStateService } from '../complaints/complaint-state.service';
import { ComplaintNotFoundError } from '../complaints/errors';
import { assertTransition } from '../complaints/state-machine';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { LlmOutputError, LlmUnavailableError } from './llm.errors';
import { GenerationPipeline } from './pipeline';
import { ProgressHub } from './progress.hub';
import { RunResultBuilder } from './run-result';

/**
 * 생성 요청을 받아 즉시 run_id를 돌려주고, 파이프라인은 백그라운드에서 돌린다(backend-spec 4번).
 * 진행은 ProgressHub로 SSE에 흘리고, 결과는 DB(generation_runs, drafts)에 남겨 GET으로도 볼 수 있게 한다.
 */
@Injectable()
export class GenerationRunner implements OnModuleInit {
  private readonly logger = new Logger('Generation');
  /** 테스트에서 백그라운드 실행 완료를 기다리기 위해 보관 */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: GenerationPipeline,
    private readonly state: ComplaintStateService,
    private readonly hub: ProgressHub,
    private readonly results: RunResultBuilder,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** 재시작으로 끊긴 실행은 error로 정리한다(메모리 버퍼는 이미 사라졌다). */
  async onModuleInit(): Promise<void> {
    await this.prisma.generationRun.updateMany({
      where: { status: 'running' },
      data: { status: 'error', error: '서버 재시작으로 생성이 중단되었습니다. 다시 생성해 주세요.', finishedAt: new Date() },
    });
  }

  async start(complaintId: string): Promise<GenerateAccepted> {
    const complaint = await this.prisma.complaint.findUnique({ where: { id: complaintId }, select: { status: true } });
    if (!complaint) throw new ComplaintNotFoundError(complaintId);
    assertTransition(complaint.status, 'draft'); // approved·sent면 409

    const runId = randomUUID();
    const model = this.env.MODEL;
    this.hub.begin(complaintId, runId); // 실행 중이면 409
    try {
      await this.prisma.generationRun.create({ data: { id: runId, complaintId, model } });
    } catch (e) {
      this.hub.finish(complaintId, { type: 'error', data: { run_id: runId, model, message: '생성을 시작하지 못했습니다.' } });
      throw e;
    }
    this.hub.publish(complaintId, { type: 'run_started', data: { run_id: runId, model } });

    const job = this.execute(complaintId, runId, model).finally(() => this.inflight.delete(runId));
    this.inflight.set(runId, job);
    return { complaint_id: complaintId, run_id: runId };
  }

  /** 테스트·스크립트용: 실행이 끝날 때까지 기다린다 */
  async waitFor(runId: string): Promise<void> {
    await this.inflight.get(runId);
  }

  private async execute(complaintId: string, runId: string, model: string): Promise<void> {
    const started = Date.now();
    try {
      const { content } = await this.prisma.complaint.findUniqueOrThrow({ where: { id: complaintId } });
      const out = await this.pipeline.run(content, model, (e) => {
        const { type, ...rest } = e;
        this.hub.publish(complaintId, { type, data: { run_id: runId, model, ...rest } });
      });

      if (out.result.candidates.length === 0) {
        await this.prisma.generationRun.update({ where: { id: runId }, data: { failed: out.failed, timings: out.timings } });
        throw new LlmOutputError('write', '모든 답변 후보 생성에 실패');
      }

      const drafts = out.result.candidates.map((candidate) => ({ id: randomUUID(), candidate }));
      await this.prisma.$transaction(async (tx) => {
        await this.state.transition(complaintId, { to: 'draft', runId, model, drafts }, tx);
        await tx.generationRun.update({
          where: { id: runId },
          data: {
            status: 'done',
            isInfoSufficient: out.result.is_info_sufficient,
            insufficientReason: out.result.insufficient_reason ?? null,
            failed: out.failed,
            timings: out.timings,
            evidence: out.evidence,
            finishedAt: new Date(),
          },
        });
      });

      const response = await this.results.build(runId);
      this.logger.log(
        `run=${runId} done candidates=${drafts.length} failed=${out.failed.length} ms=${Date.now() - started}`,
      );
      this.hub.finish(complaintId, { type: 'done', data: { run_id: runId, ...response } });
    } catch (e) {
      const message = userMessage(e);
      this.logger.warn(`run=${runId} error=${e instanceof Error ? e.name : 'unknown'} ms=${Date.now() - started}`);
      await this.prisma.generationRun
        .update({ where: { id: runId }, data: { status: 'error', error: message, finishedAt: new Date() } })
        .catch(() => undefined);
      this.hub.finish(complaintId, { type: 'error', data: { run_id: runId, model, message } });
    }
  }
}

/** 담당자에게 보여줄 한국어 메시지. 알 수 없는 에러의 내부 메시지(쿼리·본문이 섞일 수 있음)는 노출하지 않는다. */
function userMessage(e: unknown): string {
  if (e instanceof LlmUnavailableError || e instanceof LlmOutputError) return e.message;
  if (e instanceof Error && ['InvalidTransitionError', 'TransitionPreconditionError', 'ComplaintNotFoundError'].includes(e.name)) {
    return e.message;
  }
  return '답변 생성 중 알 수 없는 오류가 발생했습니다. 다시 시도해 주세요.';
}
