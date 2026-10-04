import type { SearchEngine } from '@minwon/contracts';

/** 검색 인터페이스(DI 토큰). 구현체는 SEARCH_ENGINE=mock|vector 로 선택한다. 생성 쪽은 이 인터페이스만 쓴다. */
export const SEARCH_ENGINE = Symbol('SEARCH_ENGINE');
export type { SearchEngine };
