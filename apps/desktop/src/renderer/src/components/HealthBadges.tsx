import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Health } from '../types';

const REFRESH_MS = 30_000;
const NAMES = { db: 'DB', embedding: '임베딩', llm: 'LLM' } as const;

/**
 * 헤더 오른쪽 상태 배지(KRDS badge). "검색·저장은 이 PC에서 로컬로 돈다"를 보여주는 용도. 30초마다 갱신.
 * 로컬·정상 = success, 외부·정상 = information, 연결 안 됨 = danger
 */
export function HealthBadges() {
  const [health, setHealth] = useState<Health | null>(null);
  const [down, setDown] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const h = await api<Health>('GET', '/health');
        if (alive) {
          setHealth(h);
          setDown(false);
        }
      } catch {
        if (alive) setDown(true);
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="krds-badge-wrap" aria-label="시스템 상태">
      {down && <span className="krds-badge bg-light-danger">서버 연결 안 됨</span>}
      {!down &&
        health &&
        (Object.keys(NAMES) as (keyof typeof NAMES)[]).map((k) => {
          const c = health.components[k];
          const cls = !c.ok ? 'bg-light-danger' : c.local ? 'bg-light-success' : 'bg-light-information';
          const title = `${c.host}${c.model ? ` · ${c.model}` : ''}`;
          return (
            <span key={k} className={`krds-badge ${cls}`} title={title}>
              {NAMES[k]} {c.local ? '로컬' : '외부'} · {c.ok ? '정상' : '연결 안 됨'}
            </span>
          );
        })}
    </div>
  );
}
