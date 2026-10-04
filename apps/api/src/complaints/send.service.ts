import { Inject, Injectable } from '@nestjs/common';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../corpus/embedding.port';
import { PrismaService } from '../prisma/prisma.service';
import { ComplaintStateService } from './complaint-state.service';
import { ComplaintNotFoundError, EmbeddingFailedError, TransitionPreconditionError } from './errors';
import { assertTransition } from './state-machine';

/**
 * 발송(approved → sent) + 코퍼스 추가 (backend-spec 3번 불변식, architecture ⑧).
 *   1) 트랜잭션 밖에서 최종본(edited_answer ?? answer)을 임베딩. 실패하면 여기서 중단 → 상태는 approved 그대로.
 *   2) 한 트랜잭션에서 sent 전이 + corpus_entries 추가. 하나라도 실패하면 둘 다 롤백.
 * 외부 전송은 없다(시연).
 */
@Injectable()
export class SendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ComplaintStateService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedding: EmbeddingProvider,
  ) {}

  async send(complaintId: string): Promise<void> {
    const complaint = await this.prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!complaint) throw new ComplaintNotFoundError(complaintId);
    // 임베딩 호출 전에 불허 전이를 걸러낸다. 최종 판정은 transition() 안에서 행 잠금 후 다시 한다.
    assertTransition(complaint.status, 'sent');

    const selected = await this.prisma.draft.findMany({
      where: { complaintId, selected: true, superseded: false },
    });
    if (selected.length !== 1) {
      throw new TransitionPreconditionError('선택된 답변 후보가 없습니다. 후보 하나를 선택해 주세요.');
    }
    const content = selected[0].editedAnswer ?? selected[0].answer;

    let vector: number[];
    try {
      [vector] = await this.embedding.embed([content]);
    } catch (e) {
      throw new EmbeddingFailedError(e);
    }
    if (!vector?.length) throw new EmbeddingFailedError();

    await this.state.transition(complaintId, {
      to: 'sent',
      content,
      embedding: vector,
      embeddingModel: this.embedding.model,
    });
  }
}
