import { API_BASE_URL } from './config';

/** 백엔드 오류. message는 백엔드가 준 한국어 문구 그대로 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const NETWORK_ERROR = '서버에 연결할 수 없습니다. 백엔드(apps/api)가 실행 중인지 확인해 주세요.';

/** JSON API 호출. 실패하면 ApiError(백엔드의 한국어 메시지). 원문·스택은 남기지 않는다. */
export async function api<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE_URL + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(NETWORK_ERROR, 0);
  }
  const json = (await res.json().catch(() => ({}))) as { message?: unknown };
  if (!res.ok) {
    const msg = typeof json.message === 'string' ? json.message : `요청을 처리하지 못했습니다(${res.status}).`;
    throw new ApiError(msg, res.status);
  }
  return json as T;
}

export const errorMessage = (e: unknown): string => (e instanceof ApiError ? e.message : '알 수 없는 오류가 발생했습니다.');

export const progressUrl = (complaintId: string) => `${API_BASE_URL}/complaints/${complaintId}/progress`;
