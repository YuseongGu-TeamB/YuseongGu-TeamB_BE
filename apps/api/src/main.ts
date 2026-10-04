import path from 'node:path';
import 'reflect-metadata';
import { config } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { ENV, type Env } from './config/env';

// .env는 저장소 루트에 하나만 둔다. 이미 설정된 환경변수가 우선한다.
// (PrismaService·ENV는 NestFactory.create 시점에 환경변수를 읽으므로 그 전에 불러오면 된다)
config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule.forRoot());
  configureApp(app);
  await app.listen(app.get<Env>(ENV).PORT);
}

void bootstrap();
