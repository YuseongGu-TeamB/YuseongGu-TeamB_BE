import { Module } from '@nestjs/common';
import { ComplaintsModule } from './complaints/complaints.module';
import { EnvModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

// dev 시드 API는 4단계에서 등록한다.
@Module({
  imports: [EnvModule, PrismaModule, HealthModule, ComplaintsModule],
})
export class AppModule {}
