import { execSync } from 'node:child_process';
import path from 'node:path';
import { config } from 'dotenv';
import { Client } from 'pg';

/** db 프로젝트 전: 테스트 DB(docker compose의 db-test) 접속 확인 + 마이그레이션 적용 */
export default async function globalSetup(): Promise<void> {
  config({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://app:app@localhost:5433/minwon_test';

  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (e) {
    throw new Error(`테스트 DB에 접속할 수 없습니다(${url}). 먼저 \`pnpm db:test:up\`을 실행하세요.\n${String(e)}`);
  } finally {
    await client.end().catch(() => undefined);
  }

  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
