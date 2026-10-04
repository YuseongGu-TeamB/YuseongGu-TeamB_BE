import { Module } from '@nestjs/common';
import { ComplaintsModule } from './complaints/complaints.module';
import { EnvModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';

// 검색 vector 구현·health·dev 시드 API는 3·4단계에서 등록한다.
@Module({
  imports: [EnvModule, PrismaModule, ComplaintsModule],
})
export class AppModule {}
