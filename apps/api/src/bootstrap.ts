import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ENV, type Env } from './config/env';
import { ErrorFilter } from './http/error.filter';

/** main.ts와 e2e 테스트가 같은 설정을 쓰도록 분리 */
export function configureApp(app: INestApplication): void {
  const env = app.get<Env>(ENV);
  app.enableCors({ origin: env.CORS_ORIGINS });
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('민원 답변 자동화 API').setDescription('backend-spec.md 6번').setVersion('0.1').build(),
  );
  SwaggerModule.setup('docs', app, doc);
}
