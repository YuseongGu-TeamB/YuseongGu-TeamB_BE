import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'DB·LLM·임베딩 연결 상태와 각 엔드포인트가 로컬(loopback/사설 IP)인지' })
  get() {
    return this.health.check();
  }
}
