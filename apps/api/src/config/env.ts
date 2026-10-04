import { z } from 'zod';

/** JSON 문자열 환경변수(OLLAMA_OPTIONS, LLM_EXTRA_BODY). 비어 있으면 undefined. */
const jsonObject = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v?.trim()) return undefined;
    try {
      const parsed: unknown = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* 아래에서 보고 */
    }
    ctx.addIssue({ code: 'custom', message: 'JSON 객체 문자열이어야 합니다' });
    return z.NEVER;
  });

const csv = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const int = (def: number) => z.coerce.number().int().positive().default(def);

/** backend-spec 7번. 기본값은 .env.example과 같다. */
export const EnvSchema = z.object({
  OPENAI_BASE_URL: z.string().url().default('http://localhost:11434/v1'),
  OPENAI_API_KEY: z.string().default('ollama'),
  MODEL: z.string().min(1).default('qwen2.5:7b'),
  LLM_MAX_TOKENS: int(512),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  LLM_TIMEOUT_MS: int(120_000),
  LLM_CONCURRENCY: int(2),
  OLLAMA_OPTIONS: jsonObject,
  LLM_EXTRA_BODY: jsonObject,

  EMBEDDING_BASE_URL: z.string().url().default('http://localhost:11434/v1'),
  EMBEDDING_MODEL: z.string().min(1).default('bge-m3'),
  EMBEDDING_DIM: int(1024),

  SEARCH_ENGINE: z.enum(['mock', 'vector']).default('vector'),
  SEARCH_TOP_K: int(3),
  SEARCH_HYBRID: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  DATABASE_URL: z.string().min(1),
  PORT: int(3000),
  CORS_ORIGINS: csv('http://localhost:5173'),
  COMPLAINT_MAX_CHARS: int(5000),
  REQUIRE_LOCAL: csv('db,embedding').pipe(z.array(z.enum(['db', 'embedding', 'llm']))),

  DEV_API_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DEV_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export const ENV = Symbol('ENV');

/** 빈 문자열은 "설정 안 함"으로 본다(.env의 `KEY=` 줄). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`);
    throw new Error(`환경변수 설정 오류:\n${lines.join('\n')}`);
  }
  return result.data;
}
