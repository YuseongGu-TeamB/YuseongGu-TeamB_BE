import { GenerateApiResponseSchema } from '@minwon/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, progressUrl } from './api';
import type { Approach, ComplaintView, GenerateApiResponse } from './types';

export type StepStatus = 'waiting' | 'running' | 'done' | 'failed';

/** 진행 목록: 유사 답변 검색 → 민원 분석 → 근거·접근 유형 결정 → 후보 작성(접근 유형별) */
export interface Progress {
  search: StepStatus;
  analyze: StepStatus;
  select: StepStatus;
  write: StepStatus;
  candidates: { approach: Approach; status: StepStatus; reason?: string }[];
}

export type GenerationState =
  | { phase: 'idle' }
  | { phase: 'running'; complaintId: string; runId: string; progress: Progress }
  | { phase: 'done'; complaintId: string; result: GenerateApiResponse; progress: Progress }
  | { phase: 'error'; complaintId?: string; message: string; progress?: Progress };

const emptyProgress = (): Progress => ({
  search: 'waiting',
  analyze: 'waiting',
  select: 'waiting',
  write: 'waiting',
  candidates: [],
});

const MAX_SSE_ERRORS = 5; // 재연결이 이만큼 실패하면 GET /complaints/:id 폴링으로 확인
const POLL_MS = 2000;

/** done 이벤트·GET 결과를 계약 스키마로 검증한다(run_id 등 이벤트 부가 필드는 제외) */
function parseResult(data: Record<string, unknown>): GenerateApiResponse | null {
  const { run_id: _runId, ...rest } = data;
  const r = GenerateApiResponseSchema.safeParse(rest);
  return r.success ? r.data : null;
}

/** 진행 이벤트를 상태에 반영. 재연결 시 지난 이벤트가 다시 오므로 덮어쓰기만 한다(중복 무해). */
function apply(p: Progress, type: string, d: Record<string, unknown>): Progress {
  const stage = String(d.stage ?? '');
  const key = (stage.startsWith('write:') ? 'write' : stage) as keyof Omit<Progress, 'candidates'>;
  const setCandidate = (approach: Approach, status: StepStatus, reason?: string): Progress => {
    const others = p.candidates.filter((c) => c.approach !== approach);
    const prev = p.candidates.find((c) => c.approach === approach);
    const next = { approach, status, ...(reason && { reason }) };
    return { ...p, write: 'running', candidates: prev ? p.candidates.map((c) => (c.approach === approach ? next : c)) : [...others, next] };
  };
  switch (type) {
    case 'stage_started':
      if (stage.startsWith('write:')) return setCandidate(stage.slice(6) as Approach, 'running');
      return key in p ? { ...p, [key]: 'running' } : p;
    case 'stage_completed':
      return key in p && key !== 'write' ? { ...p, [key]: 'done' } : p;
    case 'candidate_completed':
      return setCandidate(d.approach as Approach, 'done');
    case 'candidate_failed':
      return setCandidate(d.approach as Approach, 'failed', String(d.reason ?? ''));
    default:
      return p;
  }
}

const EVENT_TYPES = ['run_started', 'stage_started', 'stage_completed', 'candidate_completed', 'candidate_failed'];

/**
 * 생성 시작(quick 또는 generate) 후 SSE로 진행을 따라간다.
 * SSE가 끊기면 EventSource가 재연결하고(서버가 지난 이벤트를 다시 보냄), 계속 실패하면 GET으로 결과를 확인한다.
 */
export function useGeneration() {
  const [state, setState] = useState<GenerationState>({ phase: 'idle' });
  const cleanup = useRef<() => void>(() => undefined);

  useEffect(() => () => cleanup.current(), []);

  const follow = useCallback((complaintId: string, runId: string) => {
    cleanup.current();
    let progress = emptyProgress();
    let finished = false;
    let sseErrors = 0;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource(progressUrl(complaintId));

    const finish = (next: GenerationState) => {
      if (finished) return;
      finished = true;
      es.close();
      if (pollTimer) clearTimeout(pollTimer);
      setState(next);
    };
    const fail = (message: string) => finish({ phase: 'error', complaintId, message, progress });
    const succeed = (result: GenerateApiResponse | null) => {
      if (!result) return fail('생성 결과 형식이 올바르지 않습니다. 다시 시도해 주세요.');
      for (const k of ['search', 'analyze', 'select', 'write'] as const) if (progress[k] !== 'failed') progress = { ...progress, [k]: 'done' };
      finish({ phase: 'done', complaintId, result, progress });
    };

    setState({ phase: 'running', complaintId, runId, progress });

    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (ev) => {
        sseErrors = 0;
        const data = JSON.parse((ev as MessageEvent<string>).data) as Record<string, unknown>;
        if (data.run_id !== runId) return; // 이전 실행의 이벤트는 무시
        progress = apply(progress, type, data);
        setState({ phase: 'running', complaintId, runId, progress });
      });
    }
    es.addEventListener('done', (ev) => {
      const data = JSON.parse((ev as MessageEvent<string>).data) as Record<string, unknown>;
      if (data.run_id === runId) succeed(parseResult(data));
    });
    es.addEventListener('error', (ev) => {
      // 서버가 보낸 error 이벤트(data 있음) vs 연결 오류(data 없음)
      const data = (ev as MessageEvent<string>).data;
      if (data) {
        const d = JSON.parse(data) as { run_id?: string; message?: string };
        if (d.run_id === runId) fail(d.message ?? '답변 생성에 실패했습니다.');
        return;
      }
      sseErrors++;
      if (sseErrors >= MAX_SSE_ERRORS || es.readyState === EventSource.CLOSED) {
        es.close();
        poll();
      }
    });

    // SSE로 끝내 못 받으면 GET /complaints/:id 로 최신 실행 결과를 확인
    const poll = async () => {
      if (finished) return;
      try {
        const view = await api<ComplaintView>('GET', `/complaints/${complaintId}`);
        const g = view.generation;
        if (g?.run_id === runId && g.status === 'done') return succeed(g.result);
        if (g?.run_id === runId && g.status === 'error') return fail(g.error ?? '답변 생성에 실패했습니다.');
      } catch {
        /* 서버가 잠시 내려간 경우 계속 확인 */
      }
      pollTimer = setTimeout(() => void poll(), POLL_MS);
    };

    cleanup.current = () => {
      finished = true;
      es.close();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);

  const reset = useCallback(() => {
    cleanup.current();
    setState({ phase: 'idle' });
  }, []);

  return { state, follow, reset, setError: (message: string, complaintId?: string) => setState({ phase: 'error', message, complaintId }) };
}
