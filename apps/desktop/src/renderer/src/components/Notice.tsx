import type { ReactNode } from 'react';

/**
 * 알림. KRDS에 일반 알림 박스가 없어 critical alerts(html/code/critical_alerts.html)로 대체한다.
 * 배지 색은 danger·info·ok뿐이라 경고는 danger에 "주의" 라벨을 쓴다.
 */
const BADGE = {
  error: { cls: 'danger', label: '오류' },
  warning: { cls: 'danger', label: '주의' },
  info: { cls: 'info', label: '안내' },
  success: { cls: 'ok', label: '완료' },
} as const;

export function Notice({ kind, children, action }: { kind: keyof typeof BADGE; children: ReactNode; action?: ReactNode }) {
  const b = BADGE[kind];
  return (
    <div className="main-urgent-wrap" role={kind === 'error' || kind === 'warning' ? 'alert' : 'status'}>
      <ul className="krds-critical-alerts">
        <li>
          <div className="critical-ban">
            <span className={`critical-badge ${b.cls}`}>{b.label}</span>
            <p className="critical-txt">{children}</p>
            {action}
          </div>
        </li>
      </ul>
    </div>
  );
}
