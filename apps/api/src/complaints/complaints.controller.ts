import {
  Body,
  Controller,
  Get,
  HttpCode,
  MessageEvent,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Sse,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Observable, map, of } from 'rxjs';
import { z } from 'zod';
import { GenerationRunner } from '../generation/generation.runner';
import { ProgressHub } from '../generation/progress.hub';
import { parseBody } from '../http/validation';
import { PrismaService } from '../prisma/prisma.service';
import { ComplaintsService, complaintBodySchema, draftPatchSchema } from './complaints.service';
import { ComplaintNotFoundError } from './errors';

/** 잘못된 id 형식은 "없음"으로 처리한다 */
const Id = new ParseUUIDPipe({ exceptionFactory: () => new NotFoundException('대상을 찾을 수 없습니다.') });

const swaggerSchema = (s: z.ZodType) => {
  const { $schema: _omit, ...rest } = z.toJSONSchema(s) as Record<string, unknown>;
  return rest;
};

@ApiTags('complaints')
@Controller('complaints')
export class ComplaintsController {
  constructor(
    private readonly complaints: ComplaintsService,
    private readonly runner: GenerationRunner,
    private readonly hub: ProgressHub,
    private readonly prisma: PrismaService,
  ) {}

  private get bodySchema() {
    return complaintBodySchema(this.complaints.env.COMPLAINT_MAX_CHARS);
  }

  @Post()
  @ApiOperation({ summary: '① 민원 접수 → received' })
  @ApiBody({ schema: swaggerSchema(complaintBodySchema(5000)) })
  create(@Body() body: unknown) {
    return this.complaints.create(parseBody(this.bodySchema, body).content);
  }

  @Post('quick')
  @HttpCode(202)
  @ApiOperation({ summary: '접수 + 생성 시작을 한 번에. 즉시 202 { complaint_id, run_id }' })
  @ApiBody({ schema: swaggerSchema(complaintBodySchema(5000)) })
  async quick(@Body() body: unknown) {
    const { content } = parseBody(this.bodySchema, body);
    const c = await this.complaints.create(content);
    return this.runner.start(c.complaint_id);
  }

  @Post(':id/generate')
  @HttpCode(202)
  @ApiOperation({ summary: '②~⑤ 생성 시작(재생성 포함). 즉시 202 { complaint_id, run_id }. 진행 중이면 409' })
  generate(@Param('id', Id) id: string) {
    return this.runner.start(id);
  }

  @Sse(':id/progress')
  @ApiOperation({ summary: 'SSE 진행 이벤트. 지난 이벤트 재전송 후 이어서, done(결과 포함) 또는 error로 끝난다' })
  async progress(@Param('id', Id) id: string): Promise<Observable<MessageEvent>> {
    const live = this.hub.stream(id);
    if (live) return live.pipe(map((e) => ({ type: e.type, data: e.data })));

    // 버퍼가 없으면(만료·재시작) 최신 실행 결과를 마지막 이벤트로 한 번 보낸다
    const exists = await this.prisma.complaint.count({ where: { id } });
    if (!exists) throw new ComplaintNotFoundError(id);
    const view = await this.complaints.view(id);
    const g = view.generation;
    if (!g) throw new NotFoundException('이 민원에는 생성 기록이 없습니다.');
    if (g.status === 'done') return of({ type: 'done', data: { run_id: g.run_id, ...g.result } });
    return of({ type: 'error', data: { run_id: g.run_id, model: g.model, message: g.error ?? '생성이 완료되지 않았습니다.' } });
  }

  @Get(':id')
  @ApiOperation({ summary: '민원 + 현재 후보 + 상태 + 최신 생성 실행(running|done|error)과 결과' })
  get(@Param('id', Id) id: string) {
    return this.complaints.view(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: '⑦ 선택된 후보 기준 approved' })
  approve(@Param('id', Id) id: string) {
    return this.complaints.approve(id);
  }

  @Post(':id/send')
  @HttpCode(200)
  @ApiOperation({ summary: '⑦⑧ sent 전이 + 근거 코퍼스 추가. 외부 전송 없음(시연)' })
  send(@Param('id', Id) id: string) {
    return this.complaints.send(id);
  }
}

@ApiTags('drafts')
@Controller('drafts')
export class DraftsController {
  constructor(private readonly complaints: ComplaintsService) {}

  @Patch(':id')
  @ApiOperation({ summary: '후보 선택·수정(민원이 draft일 때만). 선택은 민원당 1개' })
  @ApiBody({ schema: swaggerSchema(draftPatchSchema(5000)) })
  update(@Param('id', Id) id: string, @Body() body: unknown) {
    return this.complaints.updateDraft(id, parseBody(draftPatchSchema(this.complaints.env.COMPLAINT_MAX_CHARS), body));
  }
}
