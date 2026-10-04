import type { GenerateApiResponse } from '../types';
import { Disclosure } from './Disclosure';

/** source 접두어로 출처를 구분한다: A-… 발송 답변(피드백 루프), S-… 개발자 시드 */
function originBadge(source: string) {
  if (source.startsWith('A-')) return <span className="krds-badge bg-light-success">이전에 전송한 답변</span>;
  if (source.startsWith('S-')) return <span className="krds-badge bg-light-gray">시드 답변</span>;
  return null;
}

/** "이번에 검색된 유사 답변": 이번 실행의 검색 결과(evidence) 전체. 처음엔 접혀 있다. */
export function SearchedEvidence({ evidence }: { evidence: GenerateApiResponse['evidence'] }) {
  return (
    <Disclosure label={`이번에 검색된 유사 답변 (${evidence.length}건)`}>
      {evidence.length === 0 ? (
        <p className="form-hint">검색된 유사 답변이 없습니다.</p>
      ) : (
        <ul className="krds-info-list dash">
          {evidence.map((e) => (
            <li key={e.source}>
              {originBadge(e.source)} <strong>{e.source}</strong>
              <p className="app-pre">{e.content}</p>
            </li>
          ))}
        </ul>
      )}
    </Disclosure>
  );
}
