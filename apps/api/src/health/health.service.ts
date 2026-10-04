import { Inject, Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { ENV, type Env } from '../config/env';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../corpus/embedding.port';
import { PrismaService } from '../prisma/prisma.service';
import { endpointOf, hostOf, isLocalHost, type Component } from './locality';

export interface ComponentHealth {
  ok: boolean;
  /** 호스트가 loopback/사설 IP인가 */
  local: boolean;
  host: string;
  required_local: boolean;
  model?: string;
  error?: string;
}

const CHECK_TIMEOUT_MS = 5_000;

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedding: EmbeddingProvider,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async check() {
    const [db, llm, embedding] = await Promise.all([
      this.component('db', () => this.prisma.$queryRaw`SELECT 1`),
      this.component('llm', () => this.llmModels(), this.env.MODEL),
      this.component('embedding', () => this.embedding.embed(['health']), this.env.EMBEDDING_MODEL),
    ]);
    const components = { db, llm, embedding };
    return {
      status: Object.values(components).every((c) => c.ok) ? 'ok' : 'degraded',
      search_engine: this.env.SEARCH_ENGINE,
      components,
    };
  }

  private async llmModels(): Promise<void> {
    const client = new OpenAI({
      baseURL: this.env.OPENAI_BASE_URL,
      apiKey: this.env.OPENAI_API_KEY,
      timeout: CHECK_TIMEOUT_MS,
      maxRetries: 0,
    });
    await client.models.list();
  }

  private async component(c: Component, probe: () => Promise<unknown>, model?: string): Promise<ComponentHealth> {
    const host = hostOf(endpointOf(this.env, c));
    const base = { local: await isLocalHost(host), host, required_local: this.env.REQUIRE_LOCAL.includes(c), ...(model && { model }) };
    try {
      await withTimeout(probe(), CHECK_TIMEOUT_MS);
      return { ok: true, ...base };
    } catch (e) {
      return { ok: false, ...base, error: e instanceof Error ? e.name : 'unknown' };
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
