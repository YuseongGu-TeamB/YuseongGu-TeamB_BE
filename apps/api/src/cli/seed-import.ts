import { readFile } from 'node:fs/promises';
import path from 'node:path';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config } from 'dotenv';
import { EnvModule } from '../config/config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SeedModule } from '../seed/seed.module';
import { SeedService } from '../seed/seed.service';

/**
 * 시드 Excel import CLI (backend-spec 6-2). API와 같은 SeedService 로직을 쓴다.
 *   pnpm seed:import <파일.xlsx> [--replace] [--dry-run]
 */
config({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });

@Module({ imports: [EnvModule, PrismaModule, SeedModule] })
class SeedCliModule {}

const USAGE = '사용법: pnpm seed:import <파일.xlsx> [--replace] [--dry-run]';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a.startsWith('--') && !['--replace', '--dry-run'].includes(a));
  const files = args.filter((a) => !a.startsWith('--'));
  if (unknown.length > 0 || files.length !== 1) {
    console.error(USAGE);
    return 1;
  }
  // pnpm은 스크립트를 패키지 폴더에서 실행하므로, 사용자가 명령을 친 위치(INIT_CWD) 기준으로 경로를 푼다
  const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), files[0]);
  const mode = args.includes('--replace') ? 'replace' : 'append';
  const dryRun = args.includes('--dry-run');

  const app = await NestFactory.createApplicationContext(SeedCliModule, { logger: ['error', 'warn'] });
  try {
    const result = await app.get(SeedService).import(await readFile(file), { mode, dryRun });
    console.log(`${dryRun ? '[dry-run: DB 변경 없음] ' : ''}mode=${mode} 파일=${path.basename(file)}`);
    console.log(`  전체 ${result.total} / 추가 ${result.inserted} / 갱신 ${result.updated} / 건너뜀 ${result.skipped}`);
    for (const e of result.errors) console.log(`  - ${e.row}행: ${e.reason}`);
    return 0;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`시드 import 실패: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
