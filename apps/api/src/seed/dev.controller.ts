import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { parseBody } from '../http/validation';
import { DevKeyGuard } from './dev-key.guard';
import { SEED_LIMITS, SeedFileError, SeedService } from './seed.service';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const importQuery = z.object({
  mode: z.enum(['append', 'replace']).default('append'),
  dryRun: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** 개발자 전용(시연 준비용). DEV_API_ENABLED=true일 때만 등록되고, X-Dev-Key가 필요하다. */
@ApiTags('dev')
@ApiHeader({ name: 'X-Dev-Key', required: true })
@UseGuards(DevKeyGuard)
@Controller('dev')
export class DevController {
  constructor(private readonly seeds: SeedService) {}

  @Get('seed/template.xlsx')
  @Header('Content-Type', XLSX)
  @Header('Content-Disposition', 'attachment; filename="seed-template.xlsx"')
  @ApiOperation({ summary: '빈 양식(헤더 + 예시 1행)' })
  async template() {
    return new StreamableFile(await this.seeds.template());
  }

  @Post('seed/import')
  @HttpCode(200)
  @ApiOperation({ summary: '.xlsx 업로드(필드명 file). mode=append|replace, dryRun=true|false' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } })
  @ApiQuery({ name: 'mode', required: false, enum: ['append', 'replace'] })
  @ApiQuery({ name: 'dryRun', required: false, enum: ['true', 'false'] })
  // 메모리에서만 처리한다 — 디스크 임시 파일을 만들지 않는다
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: SEED_LIMITS.fileBytes, files: 1 } }))
  async import(@UploadedFile() file: Express.Multer.File | undefined, @Query() query: unknown) {
    const opts = parseBody(importQuery, query);
    if (!file) throw new SeedFileError('업로드 파일(필드명 file)이 없습니다.');
    if (!file.originalname.toLowerCase().endsWith('.xlsx')) throw new SeedFileError('.xlsx 파일만 업로드할 수 있습니다.');
    return this.seeds.import(file.buffer, opts);
  }

  @Get('seed')
  @ApiOperation({ summary: '현재 코퍼스 목록(source, content 앞부분, origin, 등록 시각)' })
  list() {
    return this.seeds.list();
  }

  @Get('seed/export.xlsx')
  @Header('Content-Type', XLSX)
  @Header('Content-Disposition', 'attachment; filename="seed-export.xlsx"')
  @ApiOperation({ summary: '현재 시드(origin=seed)를 같은 양식으로 내보내기' })
  async export() {
    return new StreamableFile(await this.seeds.export());
  }

  @Delete('seed/:source')
  @HttpCode(204)
  @ApiOperation({ summary: '시드 1건 삭제(origin=seed만)' })
  async delete(@Param('source') source: string) {
    await this.seeds.delete(source);
  }

  @Post('corpus/reembed')
  @HttpCode(200)
  @ApiOperation({ summary: '전체 코퍼스를 현재 EMBEDDING_MODEL로 재임베딩' })
  reembed() {
    return this.seeds.reembed();
  }
}
