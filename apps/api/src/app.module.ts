import { DynamicModule, Module } from '@nestjs/common';
import { ComplaintsModule } from './complaints/complaints.module';
import { EnvModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { DevModule } from './seed/dev.module';

@Module({})
export class AppModule {
  /**
   * 개발자 시드 API(/dev)는 DEV_API_ENABLED=true일 때만 라우트를 등록한다(backend-spec 6-2).
   * .env를 읽은 뒤에 호출해야 하므로 데코레이터가 아니라 함수로 구성한다.
   */
  static forRoot(opts: { devApi?: boolean } = {}): DynamicModule {
    const devApi = opts.devApi ?? process.env.DEV_API_ENABLED === 'true';
    return {
      module: AppModule,
      imports: [EnvModule, PrismaModule, HealthModule, ComplaintsModule, ...(devApi ? [DevModule] : [])],
    };
  }
}
