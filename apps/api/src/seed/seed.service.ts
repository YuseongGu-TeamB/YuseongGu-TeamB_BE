import { Inject, Injectable, Logger } from '@nestjs/common';
import { SOURCE_REGEX } from '@minwon/contracts';
import ExcelJS from 'exceljs';
import { CorpusRepository } from '../corpus/corpus.repository';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../corpus/embedding.port';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

/** backend-spec 6-2 제한 */
export const SEED_LIMITS = { fileBytes: 5 * 1024 * 1024, rows: 2000, contentChars: 2000 } as const;
const EMBED_BATCH = 32;

/** 파일 자체가 잘못된 경우(형식·헤더·용량·행 수) → 400 */
export class SeedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedFileError';
  }
}

export class SeedNotFoundError extends Error {
  constructor() {
    super('해당 source의 코퍼스 항목이 없습니다.');
    this.name = 'SeedNotFoundError';
  }
}

export class SeedNotDeletableError extends Error {
  constructor() {
    super('발송으로 추가된 항목(origin=sent)은 시드 API로 삭제할 수 없습니다.');
    this.name = 'SeedNotDeletableError';
  }
}

export interface ImportOptions {
  mode: 'append' | 'replace';
  dryRun: boolean;
}

export interface ImportResult {
  /** 데이터 행 수(완전히 빈 행 제외) */
  total: number;
  inserted: number;
  updated: number;
  /** 오류 행 + 내용이 같아 바꿀 것이 없는 행 */
  skipped: number;
  /** row는 엑셀 행 번호(헤더 = 1행) */
  errors: { row: number; reason: string }[];
}

interface Row {
  row: number;
  source: string;
  content: string;
}

/**
 * 개발자용 시드(사전 검수된 과거 승인 답변) Excel 입출력. API와 CLI가 같은 로직을 쓴다.
 * 시드는 RDB 답변초안과 무관한 별도 입력이다 — draft·approved 후보는 이 경로로도 코퍼스에 들어가지 않는다.
 */
@Injectable()
export class SeedService {
  private readonly logger = new Logger('Seed');

  constructor(
    private readonly prisma: PrismaService,
    private readonly corpus: CorpusRepository,
    @Inject(EMBEDDING_PROVIDER) private readonly embedding: EmbeddingProvider,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ── 양식 / 내보내기 ─────────────────────────────────────

  async template(): Promise<Buffer> {
    return this.workbook([['', '유성구는 지역경제 활성화를 위해 저녁 유예(19:00~22:00)를 운영합니다.']]);
  }

  async export(): Promise<Buffer> {
    const seeds = await this.corpus.list('seed');
    return this.workbook(seeds.map((s) => [s.source, s.content]));
  }

  private async workbook(rows: string[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('seed');
    ws.columns = [
      { header: 'source', key: 'source', width: 16 },
      { header: 'content', key: 'content', width: 100 },
    ];
    for (const [source, content] of rows) ws.addRow({ source, content });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ── 목록 / 삭제 ────────────────────────────────────────

  async list() {
    const rows = await this.corpus.list();
    return rows.map((r) => ({
      source: r.source,
      content: r.content.length > 80 ? `${r.content.slice(0, 80)}…` : r.content,
      origin: r.origin,
      embedding_model: r.embeddingModel,
      created_at: r.createdAt.toISOString(),
    }));
  }

  async delete(source: string): Promise<void> {
    const r = await this.corpus.deleteSeed(source);
    if (r === 'not_found') throw new SeedNotFoundError();
    if (r === 'not_seed') throw new SeedNotDeletableError();
  }

  // ── import ──────────────────────────────────────────────

  async import(file: Buffer, opts: ImportOptions): Promise<ImportResult> {
    const rows = await parseSeedWorkbook(file);
    const errors: ImportResult['errors'] = [];
    const fail = (row: number, reason: string) => errors.push({ row, reason });

    // 1) 행 단위 검증
    const sourceCount = new Map<string, number>();
    for (const r of rows) if (r.source) sourceCount.set(r.source, (sourceCount.get(r.source) ?? 0) + 1);
    let valid: Row[] = [];
    for (const r of rows) {
      if (!r.content) fail(r.row, '내용(content)이 비어 있습니다.');
      else if (r.content.length > SEED_LIMITS.contentChars) fail(r.row, `내용이 ${SEED_LIMITS.contentChars.toLocaleString()}자를 넘습니다.`);
      else if (r.source && !SOURCE_REGEX.test(r.source)) fail(r.row, 'source 형식 오류(영문·숫자·-·_, 최대 50자).');
      else if (r.source && sourceCount.get(r.source)! > 1) fail(r.row, `파일 안에서 source(${r.source})가 중복됩니다.`);
      else valid.push(r);
    }

    // 2) 기존 코퍼스와 비교: 발송 답변과 겹치면 오류, 시드와 겹치면 append에서 갱신
    const existing = new Map((await this.corpus.findBySources(valid.filter((r) => r.source).map((r) => r.source))).map((e) => [e.source, e]));
    valid = valid.filter((r) => {
      if (existing.get(r.source)?.origin !== 'sent') return true;
      fail(r.row, `발송으로 추가된 항목(origin=sent)과 source(${r.source})가 겹칩니다.`);
      return false;
    });

    const toInsert: Row[] = [];
    const toUpdate: Row[] = [];
    for (const r of valid) {
      const prev = r.source ? existing.get(r.source) : undefined;
      if (!prev || opts.mode === 'replace') toInsert.push(r);
      else if (prev.content === r.content) continue; // 변경 없음 → 임베딩하지 않고 skipped로 집계
      else toUpdate.push(r);
    }

    // 3) source가 빈 행은 S-0001 형식으로 자동 부여(기존·파일 안 번호와 겹치지 않게)
    await this.assignSources(toInsert, rows, opts.mode);

    const result = (inserted: number, updated: number): ImportResult => ({
      total: rows.length,
      inserted,
      updated,
      skipped: rows.length - inserted - updated,
      errors: [...errors].sort((a, b) => a.row - b.row),
    });
    if (opts.dryRun) return result(toInsert.length, toUpdate.length);

    // 4) 변경된 행만 임베딩(트랜잭션 전). 실패한 행은 오류로 보고하고 나머지는 진행(부분 성공).
    const embedded = await this.embedRows([...toInsert, ...toUpdate], fail);
    const insertedRows = toInsert.filter((r) => embedded.has(r.row));
    const updatedRows = toUpdate.filter((r) => embedded.has(r.row));

    // 5) 한 트랜잭션에서 반영 (replace는 origin='seed'만 지우고 다시 넣는다)
    await this.prisma.$transaction(async (tx) => {
      if (opts.mode === 'replace') await this.corpus.deleteAllSeeds(tx);
      for (const r of [...insertedRows, ...updatedRows]) {
        await this.corpus.upsertSeed(tx, {
          source: r.source,
          content: r.content,
          embedding: embedded.get(r.row)!,
          embeddingModel: this.embedding.model,
        });
      }
    });
    const out = result(insertedRows.length, updatedRows.length);
    this.logger.log(
      `import mode=${opts.mode} total=${out.total} inserted=${out.inserted} updated=${out.updated} skipped=${out.skipped} errors=${out.errors.length}`,
    );
    return out;
  }

  private async assignSources(toInsert: Row[], allRows: Row[], mode: ImportOptions['mode']): Promise<void> {
    const used = new Set(allRows.map((r) => r.source).filter(Boolean));
    let next = mode === 'replace' ? 0 : await this.corpus.maxSeedNumber();
    for (const s of used) {
      const m = /^S-(\d+)$/.exec(s);
      if (m) next = Math.max(next, Number(m[1]));
    }
    for (const r of toInsert) {
      if (r.source) continue;
      next++;
      r.source = `S-${String(next).padStart(4, '0')}`;
    }
  }

  private async embedRows(rows: Row[], fail: (row: number, reason: string) => void): Promise<Map<number, number[]>> {
    const out = new Map<number, number[]>();
    const accept = (r: Row, v: number[] | undefined) => {
      if (v?.length === this.env.EMBEDDING_DIM) out.set(r.row, v);
      else fail(r.row, '임베딩 결과의 차원이 맞지 않습니다.');
    };
    for (let i = 0; i < rows.length; i += EMBED_BATCH) {
      const batch = rows.slice(i, i + EMBED_BATCH);
      try {
        const vectors = await this.embedding.embed(batch.map((r) => r.content));
        batch.forEach((r, j) => accept(r, vectors[j]));
      } catch {
        // 배치가 실패하면 한 행씩 다시 시도해 실패한 행만 골라낸다
        for (const r of batch) {
          try {
            accept(r, (await this.embedding.embed([r.content]))[0]);
          } catch {
            fail(r.row, '임베딩에 실패했습니다. 임베딩 서버 상태를 확인하세요.');
          }
        }
      }
    }
    return out;
  }

  // ── 재임베딩 (backend-spec 5번) ─────────────────────────

  /** 전체 코퍼스(seed + sent)를 현재 EMBEDDING_MODEL로 다시 임베딩한다. 내용은 바꾸지 않는다. */
  async reembed(): Promise<{ total: number; updated: number; failed: { source: string; reason: string }[] }> {
    const entries = await this.corpus.list();
    const failed: { source: string; reason: string }[] = [];
    let updated = 0;
    for (let i = 0; i < entries.length; i += EMBED_BATCH) {
      const batch = entries.slice(i, i + EMBED_BATCH);
      let vectors: number[][] | undefined;
      try {
        vectors = await this.embedding.embed(batch.map((e) => e.content));
      } catch {
        for (const e of batch) failed.push({ source: e.source, reason: '임베딩에 실패했습니다.' });
        continue;
      }
      for (const [j, e] of batch.entries()) {
        if (vectors[j]?.length !== this.env.EMBEDDING_DIM) {
          failed.push({ source: e.source, reason: '임베딩 결과의 차원이 맞지 않습니다.' });
          continue;
        }
        await this.corpus.updateEmbedding(e.source, vectors[j], this.embedding.model);
        updated++;
      }
    }
    this.logger.log(`reembed model=${this.embedding.model} total=${entries.length} updated=${updated} failed=${failed.length}`);
    return { total: entries.length, updated, failed };
  }
}

/** 첫 시트, 1행 헤더(source 선택·content 필수, 그 외 열 무시). 완전히 빈 행은 건너뛴다. */
export async function parseSeedWorkbook(file: Buffer): Promise<Row[]> {
  if (file.length > SEED_LIMITS.fileBytes) throw new SeedFileError('파일이 5MB를 넘습니다.');
  // .xlsx는 zip 파일이다(PK 시그니처)
  if (file.length < 4 || file[0] !== 0x50 || file[1] !== 0x4b) throw new SeedFileError('.xlsx 파일이 아닙니다.');

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(file as unknown as ArrayBuffer);
  } catch {
    throw new SeedFileError('.xlsx 파일을 읽을 수 없습니다.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new SeedFileError('시트가 없습니다.');

  const cols = new Map<string, number>();
  ws.getRow(1).eachCell((cell, col) => {
    const name = cell.text.trim().toLowerCase();
    if (name && !cols.has(name)) cols.set(name, col);
  });
  const contentCol = cols.get('content');
  const sourceCol = cols.get('source');
  if (!contentCol) throw new SeedFileError('1행 헤더에 content 열이 없습니다. 양식(GET /dev/seed/template.xlsx)을 확인하세요.');

  const rows: Row[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const content = row.getCell(contentCol).text.trim();
    const source = sourceCol ? row.getCell(sourceCol).text.trim() : '';
    if (!content && !source) continue;
    rows.push({ row: r, source, content });
    if (rows.length > SEED_LIMITS.rows) throw new SeedFileError(`데이터 행이 ${SEED_LIMITS.rows.toLocaleString()}행을 넘습니다.`);
  }
  return rows;
}
