import { Disclosure } from './Disclosure';

/** 민원 원문. 접고 펼칠 수 있다(화면 ②는 접힌 채로, 화면 ③은 펼친 채로 시작) */
export function ComplaintPanel({ content, defaultOpen = false }: { content: string; defaultOpen?: boolean }) {
  return (
    <Disclosure label={`민원 원문 (${content.length.toLocaleString()}자)`} defaultOpen={defaultOpen}>
      <p className="app-pre">{content}</p>
    </Disclosure>
  );
}
