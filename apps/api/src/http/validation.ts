import { BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

/** 요청 본문 검증. 실패하면 400 + 필드별 사유 */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  const details = r.error.issues.map((i) => ({ field: i.path.join('.') || '(body)', reason: i.message }));
  throw new BadRequestException({
    error: 'ValidationError',
    message: `입력값이 올바르지 않습니다: ${details.map((d) => d.field).join(', ')}`,
    details,
  });
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
