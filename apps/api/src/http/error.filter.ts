import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** 통일된 에러 응답 형식 */
export interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
}

/** 도메인 에러 이름 → HTTP 상태. 메시지는 각 에러가 가진 한국어 문구를 그대로 쓴다. */
const STATUS_BY_NAME: Record<string, number> = {
  ComplaintNotFoundError: HttpStatus.NOT_FOUND,
  DraftNotFoundError: HttpStatus.NOT_FOUND,
  InvalidTransitionError: HttpStatus.CONFLICT,
  ConcurrentTransitionError: HttpStatus.CONFLICT,
  TransitionPreconditionError: HttpStatus.CONFLICT,
  DraftNotEditableError: HttpStatus.CONFLICT,
  GenerationInProgressError: HttpStatus.CONFLICT,
  EmbeddingFailedError: HttpStatus.SERVICE_UNAVAILABLE,
  LlmUnavailableError: HttpStatus.SERVICE_UNAVAILABLE,
  LlmOutputError: HttpStatus.BAD_GATEWAY,
  SeedFileError: HttpStatus.BAD_REQUEST,
  SeedNotFoundError: HttpStatus.NOT_FOUND,
  SeedNotDeletableError: HttpStatus.CONFLICT,
};

/** 프레임워크가 영어로 던지는 에러의 한국어 문구 */
const KOREAN_BY_STATUS: Partial<Record<number, string>> = {
  [HttpStatus.PAYLOAD_TOO_LARGE]: '업로드 파일이 허용 용량(5MB)을 넘습니다.',
};

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');

  catch(e: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    const body = toErrorBody(e);
    if (body.statusCode >= 500) {
      // 내부 메시지에는 쿼리 인자(민원 본문 등)가 섞일 수 있어 이름만 남긴다
      this.logger.error(`${body.statusCode} ${e instanceof Error ? e.name : typeof e}`);
    }
    res.status(body.statusCode).json(body);
  }
}

export function toErrorBody(e: unknown): ErrorBody {
  if (e instanceof HttpException) {
    const status = e.getStatus();
    const r = e.getResponse();
    const obj = typeof r === 'object' && r !== null ? (r as Record<string, unknown>) : {};
    return {
      statusCode: status,
      error: (obj.error as string) ?? HttpStatus[status] ?? 'Error',
      message:
        KOREAN_BY_STATUS[status] ??
        (Array.isArray(obj.message) ? obj.message.join(', ') : ((obj.message as string) ?? e.message)),
      ...(obj.details !== undefined && { details: obj.details }),
    };
  }
  if (e instanceof Error && STATUS_BY_NAME[e.name]) {
    const status = STATUS_BY_NAME[e.name];
    return { statusCode: status, error: e.name, message: e.message };
  }
  return { statusCode: 500, error: 'InternalServerError', message: '서버 내부 오류가 발생했습니다.' };
}
