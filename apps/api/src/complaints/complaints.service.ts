import { Inject, Injectable } from '@nestjs/common';
import type { Approach, ComplaintView, DraftView, Status } from '@minwon/contracts';
import { z } from 'zod';
import { ENV, type Env } from '../config/env';
import { RunResultBuilder } from '../generation/run-result';
import { PrismaService } from '../prisma/prisma.service';
import { ComplaintStateService } from './complaint-state.service';
import { ComplaintNotFoundError } from './errors';
import { SendService } from './send.service';

export class DraftNotFoundError extends Error {
  constructor() {
    super('답변 후보를 찾을 수 없습니다.');
    this.name = 'DraftNotFoundError';
  }
}

export class DraftNotEditableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftNotEditableError';
  }
}

export const draftPatchSchema = (maxChars: number) =>
  z
    .strictObject({
      selected: z.boolean().optional(),
      edited_answer: z.string().trim().min(1).max(maxChars).nullable().optional(),
    })
    .refine((v) => v.selected !== undefined || v.edited_answer !== undefined, {
      message: 'selected 또는 edited_answer 중 하나는 있어야 합니다',
    });
export type DraftPatch = z.infer<ReturnType<typeof draftPatchSchema>>;

export const complaintBodySchema = (maxChars: number) =>
  z.strictObject({ content: z.string().trim().min(1, '민원 본문이 비어 있습니다').max(maxChars, `민원 본문은 ${maxChars}자 이하여야 합니다`) });

@Injectable()
export class ComplaintsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ComplaintStateService,
    private readonly sender: SendService,
    private readonly results: RunResultBuilder,
    @Inject(ENV) readonly env: Env,
  ) {}

  /** ① 접수 → received */
  async create(content: string): Promise<ComplaintView> {
    const c = await this.prisma.complaint.create({ data: { content } });
    return this.view(c.id);
  }

  async view(id: string): Promise<ComplaintView> {
    const c = await this.prisma.complaint.findUnique({
      where: { id },
      include: {
        drafts: { where: { superseded: false }, orderBy: { position: 'asc' } },
        runs: { orderBy: { startedAt: 'desc' }, take: 1 },
      },
    });
    if (!c) throw new ComplaintNotFoundError(id);
    const run = c.runs[0];
    return {
      complaint_id: c.id,
      content: c.content,
      status: c.status,
      created_at: c.createdAt.toISOString(),
      drafts: c.drafts.map(toDraftView),
      generation: run
        ? {
            run_id: run.id,
            status: run.status,
            model: run.model,
            started_at: run.startedAt.toISOString(),
            finished_at: run.finishedAt?.toISOString() ?? null,
            error: run.error,
            result: run.status === 'done' ? await this.results.build(run.id) : null,
          }
        : null,
    };
  }

  /** 담당자 선택·수정. 민원이 draft일 때만, 현재 후보(superseded 아님)만. 선택은 민원당 1개. */
  async updateDraft(draftId: string, patch: DraftPatch): Promise<DraftView> {
    return this.prisma.$transaction(async (tx) => {
      const draft = await tx.draft.findUnique({ where: { id: draftId } });
      if (!draft) throw new DraftNotFoundError();
      // 승인·재생성과 겹치지 않도록 민원 행을 잠근다(상태는 바꾸지 않는다)
      const [row] = await tx.$queryRaw<{ status: Status }[]>`
        SELECT status::text AS status FROM complaints WHERE id = ${draft.complaintId}::uuid FOR UPDATE`;
      if (row.status !== 'draft') {
        throw new DraftNotEditableError('검토 중(draft)인 민원의 후보만 선택·수정할 수 있습니다.');
      }
      if (draft.superseded) throw new DraftNotEditableError('재생성 이전의 후보는 선택·수정할 수 없습니다.');

      if (patch.selected === true) {
        await tx.draft.updateMany({
          where: { complaintId: draft.complaintId, selected: true, NOT: { id: draftId } },
          data: { selected: false },
        });
      }
      const updated = await tx.draft.update({
        where: { id: draftId },
        data: {
          ...(patch.selected !== undefined && { selected: patch.selected }),
          ...(patch.edited_answer !== undefined && { editedAnswer: patch.edited_answer }),
        },
      });
      return toDraftView(updated);
    });
  }

  /** ⑦ 승인: 선택된 후보 기준 approved */
  async approve(id: string): Promise<ComplaintView> {
    await this.state.transition(id, { to: 'approved' });
    return this.view(id);
  }

  /** ⑦⑧ 발송: sent 전이 + 코퍼스 추가 (외부 전송 없음) */
  async send(id: string): Promise<ComplaintView> {
    await this.sender.send(id);
    return this.view(id);
  }
}

function toDraftView(d: {
  id: string;
  approach: Approach;
  answer: string;
  usedSources: string[];
  assumptions: string[];
  editedAnswer: string | null;
  selected: boolean;
  model: string;
}): DraftView {
  return {
    draft_id: d.id,
    approach: d.approach,
    answer: d.answer,
    used_sources: d.usedSources,
    assumptions: d.assumptions,
    edited_answer: d.editedAnswer,
    selected: d.selected,
    model: d.model,
  };
}
