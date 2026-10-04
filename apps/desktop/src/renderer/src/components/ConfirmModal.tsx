import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * 확인 대화상자. KRDS modal(html/code/modal_sample.html) 마크업 그대로.
 * KRDS 스크립트가 붙이는 상태 클래스(shown·in, body.scroll-no)를 React에서 같은 방식으로 붙인다.
 * 키보드: 열리면 확인 버튼에 포커스, Esc로 닫기, Tab은 대화상자 안에서만 순환, 닫히면 원래 위치로 포커스 복귀.
 */
export function ConfirmModal({
  open,
  title,
  children,
  confirmLabel = '예',
  cancelLabel = '아니요',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    document.body.classList.add('scroll-no');
    confirmBtn.current?.focus();
    return () => {
      document.body.classList.remove('scroll-no');
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== 'Tab' || !dialog.current) return;
    const focusable = dialog.current.querySelectorAll<HTMLElement>('button:not([disabled])');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <section className="krds-modal fade in shown" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="modal-dialog" ref={dialog}>
        <div className="modal-content">
          <div className="modal-header">
            <h2 id={titleId} className="modal-title">
              {title}
            </h2>
          </div>
          <div className="modal-conts">
            <div className="conts-area">{children}</div>
          </div>
          <div className="modal-btn btn-wrap">
            <button type="button" className="krds-btn medium tertiary" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button type="button" className="krds-btn medium primary" ref={confirmBtn} onClick={onConfirm}>
              {confirmLabel}
            </button>
          </div>
          <button type="button" className="krds-btn medium icon btn-close" onClick={onCancel}>
            <span className="sr-only">닫기</span>
            <i className="svg-icon ico-popup-close"></i>
          </button>
        </div>
      </div>
      <div className="modal-back in"></div>
    </section>
  );
}
