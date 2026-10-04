import { Module } from '@nestjs/common';
import { DevController } from './dev.controller';
import { DevKeyGuard } from './dev-key.guard';
import { SeedModule } from './seed.module';

@Module({
  imports: [SeedModule],
  controllers: [DevController],
  providers: [DevKeyGuard],
})
export class DevModule {}
