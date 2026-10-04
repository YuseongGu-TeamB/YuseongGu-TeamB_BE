import { useId, useState } from 'react';
import type { GenerateApiResponse } from '../types';

/** 근거 원문 펼치기. KRDS accordion(html/code/accordion.html), 여러 개 동시에 열 수 있다. */
export function EvidenceList({ sources, evidence }: { sources: string[]; evidence: GenerateApiResponse['evidence'] }) {
  const base = useId();
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (sources.length === 0) return <p className="form-hint">근거 없음</p>;

  const toggle = (s: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  return (
    <div className="krds-accordion" data-type="multiOpen">
      {sources.map((source, i) => {
        const isOpen = open.has(source);
        const content = evidence.find((e) => e.source === source)?.content;
        const headerId = `${base}-h${i}`;
        const bodyId = `${base}-b${i}`;
        return (
          <div key={source} className={`accordion-item${isOpen ? ' active' : ''}`}>
            <h4 className="accordion-header">
              <button
                type="button"
                id={headerId}
                className={`btn-accordion${isOpen ? ' active' : ''}`}
                aria-controls={bodyId}
                aria-expanded={isOpen}
                onClick={() => toggle(source)}
              >
                근거 {source}
              </button>
            </h4>
            <div id={bodyId} className="accordion-collapse collapse" aria-labelledby={headerId} role="region">
              <div className="accordion-body">{content ?? '근거 원문을 찾을 수 없습니다.'}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
