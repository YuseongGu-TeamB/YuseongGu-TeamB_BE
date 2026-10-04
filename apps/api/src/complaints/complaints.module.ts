import { Module } from '@nestjs/common';
import { GenerationModule } from '../generation/generation.module';
import { ComplaintStateModule } from './complaint-state.module';
import { ComplaintsController, DraftsController } from './complaints.controller';
import { ComplaintsService } from './complaints.service';

@Module({
  imports: [ComplaintStateModule, GenerationModule],
  controllers: [ComplaintsController, DraftsController],
  providers: [ComplaintsService],
})
export class ComplaintsModule {}
