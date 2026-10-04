import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Env } from '../config/env';

export type Component = 'db' | 'embedding' | 'llm';

/** 구성요소별 접속 주소 */
export function endpointOf(env: Env, c: Component): string {
  return { db: env.DATABASE_URL, embedding: env.EMBEDDING_BASE_URL, llm: env.OPENAI_BASE_URL }[c];
}

export function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, '');
}

/** loopback 또는 사설·링크로컬 IP인가 */
export function isLocalAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return false;
}

/** 호스트가 가리키는 모든 주소가 로컬일 때만 true. 이름 해석 실패는 로컬이 아닌 것으로 본다. */
export async function isLocalHost(host: string): Promise<boolean> {
  if (isIP(host)) return isLocalAddress(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => isLocalAddress(a.address));
  } catch {
    return false;
  }
}

/** REQUIRE_LOCAL에 적힌 구성요소가 로컬이 아니면 에러 (backend-spec 10번 로컬 증명 기준) */
export async function assertRequiredLocal(env: Env): Promise<void> {
  const remote: string[] = [];
  for (const c of env.REQUIRE_LOCAL) {
    const host = hostOf(endpointOf(env, c));
    if (!(await isLocalHost(host))) remote.push(`${c}(${host})`);
  }
  if (remote.length > 0) {
    throw new Error(
      `REQUIRE_LOCAL=${env.REQUIRE_LOCAL.join(',')} 인데 로컬이 아닌 구성요소가 있습니다: ${remote.join(', ')}. ` +
        `엔드포인트를 로컬로 바꾸거나 REQUIRE_LOCAL을 조정하세요.`,
    );
  }
}
