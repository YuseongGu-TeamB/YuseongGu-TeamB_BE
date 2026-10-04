import { Module } from '@nestjs/common';
import { CorpusModule } from '../corpus/corpus.module';
import { SeedService } from './seed.service';

@Module({
  imports: [CorpusModule],
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}
