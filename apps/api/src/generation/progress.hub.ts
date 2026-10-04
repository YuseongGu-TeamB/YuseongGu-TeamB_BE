import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Observable, ReplaySubject } from 'rxjs';

export interface ProgressEvent {
  /** SSE event 이름: run_started, stage_started, stage_completed, candidate_completed, candidate_failed, done, error */
  type: string;
  data: Record<string, unknown>;
}

export class GenerationInProgressError extends Error {
  constructor() {
    super('이 민원은 답변을 생성하는 중입니다. 완료된 뒤 다시 시도해 주세요.');
    this.name = 'GenerationInProgressError';
  }
}

interface RunBuffer {
  runId: string;
  subject: ReplaySubject<ProgressEvent>;
  finished: boolean;
  timer?: NodeJS.Timeout;
}

/** 완료 후 버퍼 보관 시간 (backend-spec 4번: 10분) */
export const BUFFER_TTL_MS = 10 * 60 * 1000;

/**
 * 민원별 진행 이벤트 버퍼(메모리). 구독하면 현재 실행의 지난 이벤트부터 재전송한 뒤 이어서 보낸다.
 * 서버 재시작 시 사라져도 된다(시연용). 같은 민원에 실행 중인 생성이 있으면 새 실행은 거부(409).
 */
@Injectable()
export class ProgressHub implements OnModuleDestroy {
  private readonly buffers = new Map<string, RunBuffer>();
  /** 테스트에서만 바꾼다 */
  ttlMs = BUFFER_TTL_MS;

  isRunning(complaintId: string): boolean {
    const b = this.buffers.get(complaintId);
    return !!b && !b.finished;
  }

  /** 동기 함수다 — 확인과 등록 사이에 await가 없어 동시 요청 중 하나만 통과한다. */
  begin(complaintId: string, runId: string): void {
    if (this.isRunning(complaintId)) throw new GenerationInProgressError();
    const prev = this.buffers.get(complaintId);
    if (prev?.timer) clearTimeout(prev.timer);
    this.buffers.set(complaintId, { runId, subject: new ReplaySubject<ProgressEvent>(), finished: false });
  }

  publish(complaintId: string, event: ProgressEvent): void {
    const b = this.buffers.get(complaintId);
    if (b && !b.finished) b.subject.next(event);
  }

  /** 마지막 이벤트(done/error)를 보내고 스트림을 닫는다. TTL 뒤 버퍼 삭제. */
  finish(complaintId: string, event: ProgressEvent): void {
    const b = this.buffers.get(complaintId);
    if (!b || b.finished) return;
    b.subject.next(event);
    b.finished = true;
    b.subject.complete();
    b.timer = setTimeout(() => {
      if (this.buffers.get(complaintId) === b) this.buffers.delete(complaintId);
    }, this.ttlMs);
    b.timer.unref();
  }

  /** 버퍼가 없으면 null (만료·재시작 등) */
  stream(complaintId: string): Observable<ProgressEvent> | null {
    return this.buffers.get(complaintId)?.subject.asObservable() ?? null;
  }

  onModuleDestroy(): void {
    for (const b of this.buffers.values()) if (b.timer) clearTimeout(b.timer);
    this.buffers.clear();
  }
}
