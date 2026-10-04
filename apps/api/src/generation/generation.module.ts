import { Module } from '@nestjs/common';
import { ComplaintStateModule } from '../complaints/complaint-state.module';
import { ENV, type Env } from '../config/env';
import { SearchModule } from '../search/search.module';
import { GenerationRunner } from './generation.runner';
import { createOpenAiClient, LLM_CLIENT, StructuredLlm } from './llm.client';
import { GenerationPipeline } from './pipeline';
import { ProgressHub } from './progress.hub';
import { RunResultBuilder } from './run-result';

@Module({
  imports: [SearchModule, ComplaintStateModule],
  providers: [
    { provide: LLM_CLIENT, inject: [ENV], useFactory: (env: Env) => createOpenAiClient(env) },
    StructuredLlm,
    GenerationPipeline,
    ProgressHub,
    RunResultBuilder,
    GenerationRunner,
  ],
  exports: [GenerationRunner, ProgressHub, RunResultBuilder],
})
export class GenerationModule {}
