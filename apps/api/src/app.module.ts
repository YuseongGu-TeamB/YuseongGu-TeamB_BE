import path from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';

// 라우트(complaints, dev)와 검색·생성 모듈은 2단계부터 등록한다.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: path.resolve(__dirname, '../../../.env') }),
    PrismaModule,
  ],
})
export class AppModule {}
