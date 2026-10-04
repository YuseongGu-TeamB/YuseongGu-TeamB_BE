import { Module } from '@nestjs/common';
import { CorpusModule } from '../corpus/corpus.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [CorpusModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
