import path from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// .env는 저장소 루트에 하나만 둔다. 이미 설정된 환경변수(테스트용 DATABASE_URL 등)가 우선한다.
config({ path: path.resolve(__dirname, '../../.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
