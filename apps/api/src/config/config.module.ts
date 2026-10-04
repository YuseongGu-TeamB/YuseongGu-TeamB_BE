import { Global, Module } from '@nestjs/common';
import { assertRequiredLocal } from '../health/locality';
import { ENV, loadEnv } from './env';

/**
 * 환경변수 로드 + REQUIRE_LOCAL 점검. 모든 모듈이 ENV에 의존하므로 가장 먼저 실행된다
 * — 로컬이 아닌 구성요소가 있으면 외부에 연결을 시도하기 전에 시작을 중단한다.
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: async () => {
        const env = loadEnv();
        await assertRequiredLocal(env);
        return env;
      },
    },
  ],
  exports: [ENV],
})
export class EnvModule {}
