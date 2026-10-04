import { Injectable } from '@nestjs/common';
import { GenerateApiResponseSchema, type GenerateApiResponse } from '@minwon/contracts';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 저장된 실행(run)에서 GenerateApiResponse를 다시 만든다.
 * SSE done 이벤트와 GET /complaints/:id가 같은 함수를 써서 결과 모양이 항상 같다.
 */
@Injectable()
export class RunResultBuilder {
  constructor(private readonly prisma: PrismaService) {}

  async build(runId: string): Promise<GenerateApiResponse | null> {
    const run = await this.prisma.generationRun.findUnique({
      where: { id: runId },
      include: { complaint: { select: { status: true } }, drafts: { orderBy: { position: 'asc' } } },
    });
    if (!run || run.status !== 'done') return null;

    return GenerateApiResponseSchema.parse({
      complaint_id: run.complaintId,
      status: run.complaint.status,
      model: run.model,
      result: {
        candidates: run.drafts.map((d) => ({
          answer: d.answer,
          approach: d.approach,
          used_sources: d.usedSources,
          assumptions: d.assumptions,
        })),
        is_info_sufficient: run.isInfoSufficient ?? false,
        insufficient_reason: run.insufficientReason,
      },
      drafts: run.drafts.map((d) => ({ draft_id: d.id, approach: d.approach })),
      failed: run.failed,
      timings: run.timings,
    });
  }
}
