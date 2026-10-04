import { useId, useState, type ReactNode } from 'react';

/**
 * 접고 펼치는 영역. KRDS disclosure(html/code/disclosure.html) 마크업 그대로,
 * 열림 상태는 KRDS 스크립트와 같이 active 클래스 + aria-expanded. 접혀 있으면 화면 낭독에서도 숨긴다.
 */
export function Disclosure({ label, defaultOpen = false, children }: { label: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`krds-disclosure conts-expand-area${open ? ' active' : ''}`}>
      <button type="button" className="btn-conts-expand" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      <div className="expand-wrap" id={id} aria-hidden={!open}>
        <div className="expand-in">{children}</div>
      </div>
    </div>
  );
}
