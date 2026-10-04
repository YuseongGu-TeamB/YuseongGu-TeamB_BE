import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ENV, type Env } from '../config/env';

/** 개발자 API는 X-Dev-Key 헤더가 DEV_API_KEY와 일치해야 한다(backend-spec 6-2) */
@Injectable()
export class DevKeyGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(ctx: ExecutionContext): boolean {
    const given = ctx.switchToHttp().getRequest<Request>().header('x-dev-key') ?? '';
    const expected = this.env.DEV_API_KEY ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException({ error: 'Unauthorized', message: 'X-Dev-Key가 올바르지 않습니다.' });
    }
    return true;
  }
}
