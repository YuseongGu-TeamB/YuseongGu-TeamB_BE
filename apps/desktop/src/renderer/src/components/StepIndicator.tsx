/** KRDS step indicator (html/code/step_indicator.html) */
const STEPS = ['민원 입력', '후보 선택', '수정·전송'] as const;

export function StepIndicator({ current }: { current: 1 | 2 | 3 | 'done' }) {
  const idx = current === 'done' ? STEPS.length + 1 : current;
  return (
    <ol className="krds-step-wrap">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < idx ? 'done' : n === idx ? 'active' : undefined;
        return (
          <li key={label} className={state} aria-current={state === 'active' ? 'step' : undefined}>
            <span>
              {state === 'active' && <em className="sr-only">현재단계</em>}
              <i className="step">{n}단계</i>
              <span className="step-tit">{label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
