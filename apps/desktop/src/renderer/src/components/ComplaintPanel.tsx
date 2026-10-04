/** 민원 원문(항상 표시). 화면 ②③ 왼쪽 */
export function ComplaintPanel({ content }: { content: string }) {
  return (
    <section aria-labelledby="complaint-original">
      <h2 id="complaint-original">민원 원문</h2>
      <p className="app-pre">{content}</p>
    </section>
  );
}
