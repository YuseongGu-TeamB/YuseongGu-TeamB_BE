import { Injectable } from '@nestjs/common';
import type { Candidate, Status } from '@minwon/contracts';
import { CorpusRepository } from '../corpus/corpus.repository';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { ComplaintNotFoundError, TransitionPreconditionError } from './errors';
import { assertTransition } from './state-machine';

export type TransitionInput =
  /** 생성 완료: 새 후보 저장. 재생성이면 기존 후보는 superseded로 보관 */
  | { to: 'draft'; runId: string; model: string; candidates: Candidate[] }
  /** 선택된 후보(민원당 1개) 기준 승인 */
  | { to: 'approved' }
  /** 발송: 코퍼스 추가. embedding은 트랜잭션 전에 content(= edited_answer ?? answer)로 계산해 넘긴다 */
  | { to: 'sent'; content: string; embedding: number[]; embeddingModel: string };

/**
 * 민원 상태를 바꾸는 유일한 경로(backend-spec 3번). API·테스트·스크립트 모두 transition()을 거친다.
 * complaints.status를 직접 update하는 코드를 다른 곳에 만들지 말 것.
 */
@Injectable()
export class ComplaintStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corpus: CorpusRepository,
  ) {}

  /**
   * tx를 넘기면 그 트랜잭션 안에서, 생략하면 새 트랜잭션에서 실행한다.
   * 상태 변경과 부수 효과(후보 저장, 코퍼스 추가)는 항상 같은 트랜잭션이다 — 하나라도 실패하면 모두 롤백.
   */
  async transition(complaintId: string, input: TransitionInput, tx?: Tx): Promise<Status> {
    if (!tx) return this.prisma.$transaction((t) => this.transition(complaintId, input, t));

    // 행 잠금으로 같은 민원에 대한 동시 전이를 직렬화한다.
    const rows = await tx.$queryRaw<{ status: Status }[]>`
      SELECT status::text AS status FROM complaints WHERE id = ${complaintId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new ComplaintNotFoundError(complaintId);
    const from = rows[0].status;
    assertTransition(from, input.to);

    switch (input.to) {
      case 'draft':
        await this.saveCandidates(tx, complaintId, input);
        break;
      case 'approved':
        await this.selectedDraft(tx, complaintId);
        break;
      case 'sent': {
        const draft = await this.selectedDraft(tx, complaintId);
        const finalAnswer = draft.editedAnswer ?? draft.answer;
        // 임베딩한 내용과 저장할 내용이 다르면 코퍼스가 거짓이 된다.
        if (finalAnswer !== input.content) {
          throw new TransitionPreconditionError('발송할 답변이 임베딩한 내용과 다릅니다. 다시 시도해 주세요.');
        }
        await this.corpus.insertSent(tx, {
          complaintId,
          content: finalAnswer,
          embedding: input.embedding,
          embeddingModel: input.embeddingModel,
        });
        break;
      }
    }

    await tx.complaint.update({ where: { id: complaintId }, data: { status: input.to } });
    return input.to;
  }

  private async saveCandidates(tx: Tx, complaintId: string, input: Extract<TransitionInput, { to: 'draft' }>) {
    if (input.candidates.length === 0) {
      throw new TransitionPreconditionError('저장할 답변 후보가 없습니다.');
    }
    await tx.draft.updateMany({
      where: { complaintId, superseded: false },
      data: { superseded: true, selected: false },
    });
    await tx.draft.createMany({
      data: input.candidates.map((c) => ({
        complaintId,
        runId: input.runId,
        model: input.model,
        approach: c.approach,
        answer: c.answer,
        usedSources: c.used_sources,
        assumptions: c.assumptions,
      })),
    });
  }

  private async selectedDraft(tx: Tx, complaintId: string) {
    const selected = await tx.draft.findMany({ where: { complaintId, selected: true, superseded: false } });
    if (selected.length !== 1) {
      throw new TransitionPreconditionError('선택된 답변 후보가 없습니다. 후보 하나를 선택해 주세요.');
    }
    return selected[0];
  }
}
