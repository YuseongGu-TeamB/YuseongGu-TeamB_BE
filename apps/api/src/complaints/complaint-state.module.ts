import { Module } from '@nestjs/common';
import { CorpusModule } from '../corpus/corpus.module';
import { ComplaintStateService } from './complaint-state.service';
import { SendService } from './send.service';

@Module({
  imports: [CorpusModule],
  providers: [ComplaintStateService, SendService],
  exports: [ComplaintStateService, SendService],
})
export class ComplaintStateModule {}
