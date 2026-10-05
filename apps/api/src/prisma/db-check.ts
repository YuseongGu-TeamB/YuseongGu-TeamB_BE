import { Client } from 'pg';

/**
 * 시작 전에 DB 연결을 확인한다. 연결이 안 되면 Prisma의 긴 오류 대신 원인과 조치를 한국어로 알려 준다.
 * (서버 main.ts, 시드 CLI에서 사용)
 */
export async function assertDatabaseReachable(url = process.env.DATABASE_URL ?? ''): Promise<void> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch {
    let where = 'DATABASE_URL';
    try {
      const u = new URL(url);
      where = `${u.hostname}:${u.port || 5432}`;
    } catch {
      /* URL 형식 오류면 이름만 */
    }
    throw new Error(
      `DB(${where})에 연결할 수 없습니다. Docker Desktop을 켜고 'pnpm db:up'으로 DB를 띄웠는지 확인하세요. ` +
        `처음이면 'pnpm db:migrate'도 실행하세요.`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
