import { execSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import 'reflect-metadata';
import type { GenerateApiResponse, SearchEngine } from '@minwon/contracts';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config } from 'dotenv';
import ExcelJS from 'exceljs';
import { AppModule } from '../app.module';
import { configureApp } from '../bootstrap';
import { sentSource } from '../corpus/corpus.repository';
import { LLM_CLIENT } from '../generation/llm.client';
import { PrismaService } from '../prisma/prisma.service';
import { SEARCH_ENGINE } from '../search/search.port';
import { SeedModule } from '../seed/seed.module';
import { SeedService } from '../seed/seed.service';
import { offlineChatClient } from './offline-llm';

/**
 * 스모크 테스트 (backend-spec 8·10번)
 *   pnpm smoke                       .env의 실제 엔드포인트로 전 과정
 *   pnpm smoke --no-llm              생성 단계만 결정적 응답으로 대체(인터넷 없이: 시드·임베딩·벡터 검색·발송 시 코퍼스 추가)
 *   pnpm smoke --local-llm qwen2.5:3b  LLM도 로컬 ollama(CPU)로 끝까지
 *
 * 흐름: 시드 import → 접수 → 생성(SSE) → 선택·수정 → 승인 → 발송 → 같은 민원 재검색 시 방금 답변이 근거로 나오는지
 * DB는 TEST_DATABASE_URL(docker compose의 db-test)을 쓴다 — 스모크 답변이 시연용 코퍼스에 섞이지 않게 하기 위해서다.
 * 시작할 때 그 DB의 데이터를 모두 지운다.
 */
config({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });

const SEEDS = [
  '유성구는 지역경제 활성화를 위해 저녁 유예(19:00~22:00)를 운영합니다.',
  '주민신고제 지역은 24시간 단속 대상입니다.',
  '쓰레기 무단투기는 현장 확인 후 과태료 부과 여부를 판단합니다.',
  '공사장 소음은 환경과에서 소음 측정 후 조치합니다.',
  '가로등 고장은 도로과에 접수되며 순차적으로 수리합니다.',
  '도로 파손(포트홀)은 긴급 보수 대상이며 접수 후 현장 점검합니다.',
  '공원 시설물 파손은 공원녹지과에서 확인 후 수리합니다.',
];
/** 응답 JSON (스모크 출력용이라 느슨하게 다룬다) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const COMPLAINT = '[스모크·합성] 지족로364번길에 불법주정차가 너무 심합니다. 단속 강화해주세요.';
const EDIT_MARK = '(담당자 수정: 스모크 확인용)';

/** 앱 전체 + 시드 서비스(HTTP /dev 라우트는 등록하지 않는다) */
@Module({ imports: [AppModule.forRoot({ devApi: false }), SeedModule] })
class SmokeModule {}

function parseArgs(argv: string[]) {
  const noLlm = argv.includes('--no-llm');
  const i = argv.indexOf('--local-llm');
  const localLlm = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && (!localLlm || localLlm.startsWith('--'))) throw new Error('--local-llm 뒤에 모델 이름이 필요합니다. 예: --local-llm qwen2.5:3b');
  if (noLlm && localLlm) throw new Error('--no-llm과 --local-llm은 함께 쓸 수 없습니다.');
  return { noLlm, localLlm };
}

const step = (n: number, msg: string) => console.log(`\n[${n}] ${msg}`);
const ok = (msg: string) => console.log(`    ✔ ${msg}`);

async function main(): Promise<void> {
  const { noLlm, localLlm } = parseArgs(process.argv.slice(2));

  // 환경 구성은 NestFactory.create 전에 끝낸다(ENV·PrismaService가 생성 시점에 읽는다)
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://app:app@localhost:5433/minwon_test';
  process.env.SEARCH_ENGINE = 'vector';
  process.env.DEV_API_ENABLED = 'false';
  if (noLlm) process.env.MODEL = 'offline-mock';
  if (localLlm) {
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
    process.env.OPENAI_API_KEY = 'ollama';
    process.env.MODEL = localLlm;
  }

  const mode = noLlm ? '생성 단계 mock(--no-llm)' : localLlm ? `로컬 LLM ${localLlm}` : `.env LLM ${process.env.MODEL}`;
  console.log(`스모크 시작 — ${mode}`);

  step(0, '테스트 DB 마이그레이션·초기화');
  try {
    execSync('npx prisma migrate deploy', {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, CHECKPOINT_DISABLE: '1' },
      stdio: 'pipe',
    });
  } catch (e) {
    const detail = String((e as { stderr?: unknown }).stderr ?? e);
    throw new Error(`테스트 DB 마이그레이션 실패. 'pnpm db:test:up'으로 db-test를 띄웠는지 확인하세요.\n${detail}`);
  }
  const pre = new PrismaService();
  await pre.$executeRawUnsafe('TRUNCATE corpus_entries, drafts, generation_runs, complaints RESTART IDENTITY CASCADE');
  await pre.$disconnect();

  let app: INestApplication | undefined;
  try {
    app = await NestFactory.create(SmokeModule, { logger: ['error', 'warn'] });
    if (noLlm) {
      // 생성 단계만 교체: StructuredLlm이 쥐고 있는 같은 클라이언트 객체의 chat을 바꾼다
      const client = offlineChatClient();
      const llm = app.get(LLM_CLIENT) as { chat: unknown };
      llm.chat = client.chat;
    }
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const prisma = app.get(PrismaService);

    const health = (await (await fetch(`${base}/health`)).json()) as Json;
    const c = health.components;
    console.log(
      `    health=${health.status} db(local=${c.db.local}) embedding(${c.embedding.ok ? 'ok' : 'FAIL'}, local=${c.embedding.local}) llm(${c.llm.ok ? 'ok' : 'FAIL'}, local=${c.llm.local})`,
    );
    if (!c.embedding.ok) throw new Error('임베딩 서버에 연결할 수 없습니다. ollama 실행과 `ollama pull bge-m3`를 확인하세요.');
    if (!noLlm && !c.llm.ok) throw new Error('LLM 엔드포인트에 연결할 수 없습니다. OPENAI_BASE_URL/MODEL을 확인하세요.');

    step(1, `시드 import (${SEEDS.length}건, 실제 임베딩)`);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('seed');
    ws.addRow(['source', 'content']);
    SEEDS.forEach((s) => ws.addRow(['', s]));
    const seeded = await app.get(SeedService).import(Buffer.from(await wb.xlsx.writeBuffer()), { mode: 'replace', dryRun: false });
    if (seeded.inserted !== SEEDS.length) throw new Error(`시드 import 실패: ${JSON.stringify(seeded)}`);
    ok(`inserted=${seeded.inserted}`);

    step(2, '접수');
    const created = await call(base, 'POST', '/complaints', { content: COMPLAINT });
    const id = created.complaint_id as string;
    ok(`complaint_id=${id} status=${created.status}`);

    step(3, '생성 (202 → SSE)');
    const t0 = Date.now();
    const accepted = await call(base, 'POST', `/complaints/${id}/generate`);
    ok(`202 run_id=${accepted.run_id}`);
    const done = await followSse(`${base}/complaints/${id}/progress`);
    ok(`후보 ${done.result.candidates.length}개, 실패 ${done.failed.length}개, 모델 ${done.model}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const [i, cand] of done.result.candidates.entries()) {
      console.log(`      ${i + 1}) ${cand.approach} used_sources=${JSON.stringify(cand.used_sources)} 길이=${cand.answer.length}자`);
    }

    step(4, '선택·수정 → 승인 → 발송');
    const draft = done.drafts[0];
    const finalAnswer = `${done.result.candidates[0].answer} ${EDIT_MARK}`;
    await call(base, 'PATCH', `/drafts/${draft.draft_id}`, { selected: true, edited_answer: finalAnswer });
    ok('선택·수정');
    const approved = await call(base, 'POST', `/complaints/${id}/approve`);
    ok(`status=${approved.status}`);
    const sent = await call(base, 'POST', `/complaints/${id}/send`);
    ok(`status=${sent.status}`);

    step(5, '같은 민원 재검색 → 방금 답변이 근거로 나오는가 (피드백 루프)');
    const topK = Number(process.env.SEARCH_TOP_K ?? 3);
    const results = await app.get<SearchEngine>(SEARCH_ENGINE).search(COMPLAINT, topK);
    results.forEach((r, i) => console.log(`      ${i + 1}) ${r.source}  ${r.content.slice(0, 40)}…`));
    const hit = results.find((r) => r.source === sentSource(id));
    if (!hit) throw new Error(`top_k=${topK} 검색 결과에 방금 발송한 답변(${sentSource(id)})이 없습니다.`);
    if (hit.content !== finalAnswer) throw new Error('코퍼스에 들어간 내용이 담당자 수정본과 다릅니다.');
    ok(`${sentSource(id)}가 근거로 검색됨 (수정본 그대로)`);

    const drafts = await prisma.draft.findMany({ where: { complaintId: id, selected: false } });
    const leaked = results.filter((r) => drafts.some((d) => d.answer === r.content));
    if (leaked.length > 0) throw new Error('선택되지 않은 후보가 검색 결과에 나왔습니다(불변식 위반).');
    ok('선택되지 않은 후보는 검색되지 않음');

    console.log('\n스모크 성공');
  } finally {
    await app?.close();
  }
}

async function call(base: string, method: string, url: string, body?: unknown): Promise<Json> {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (res.status === 204 ? {} : await res.json()) as Json;
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${json.message ?? ''}`);
  return json;
}

/** SSE를 끝까지 읽어 단계 진행을 출력하고 done 결과를 돌려준다 */
async function followSse(url: string): Promise<GenerateApiResponse> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const type = /^event: (.*)$/m.exec(block)?.[1];
      const dataLine = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (!type || !dataLine) continue;
      const data = JSON.parse(dataLine);
      if (type === 'stage_completed') console.log(`      · ${data.stage} ${data.ms}ms${data.tokens !== undefined ? ` ${data.tokens}tok` : ''}`);
      if (type === 'candidate_completed') console.log(`      · 후보 ${data.approach} 완료 ${data.ms}ms`);
      if (type === 'candidate_failed') console.log(`      · 후보 ${data.approach} 실패: ${data.reason}`);
      if (type === 'error') throw new Error(`생성 실패: ${data.message}`);
      if (type === 'done') {
        const { run_id: _r, ...result } = data;
        return result as GenerateApiResponse;
      }
    }
  }
  throw new Error('SSE가 done 없이 끝났습니다.');
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(`\n스모크 실패: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
