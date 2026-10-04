import { Injectable } from '@nestjs/common';
import type { SearchEngine, SearchResult } from '@minwon/contracts';

/** 레거시 mock과 같은 내용의 고정 2건. query·top_k와 무관하게 반환한다(top_k만큼 자른다). */
export const MOCK_RESULTS: readonly SearchResult[] = [
  { source: 'K-0001', content: '유성구는 지역경제 활성화를 위해 저녁 유예(19:00~22:00)를 운영합니다.' },
  { source: 'K-0002', content: '주민신고제 지역은 24시간 단속 대상입니다.' },
];

@Injectable()
export class MockSearchEngine implements SearchEngine {
  async search(query: string, top_k: number): Promise<SearchResult[]> {
    void query;
    return MOCK_RESULTS.slice(0, top_k).map((r) => ({ ...r }));
  }
}
