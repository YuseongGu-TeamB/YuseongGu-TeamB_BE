/** KRDS spinner (html/code/spinner.html) */
export function Spinner({ label = '로딩 중' }: { label?: string }) {
  return (
    <div className="krds-spinner" role="status">
      <span className="sr-only">{label}</span>
    </div>
  );
}
