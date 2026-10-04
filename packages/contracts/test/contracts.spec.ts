import { z } from 'zod';
import {
  CandidateSchema,
  GenerateApiResponseSchema,
  GenerateResponseSchema,
  SearchResultSchema,
  SOURCE_REGEX,
  StatusSchema,
} from '../src';

/**
 * 계약 스냅샷: 필드명·타입·필수 여부가 바뀌면 실패한다.
 * "타입체크 통과"와 "필드가 안 바뀜"은 다르므로 JSON Schema로 고정한다.
 */
describe('계약 스냅샷', () => {
  it.each([
    ['SearchResult', SearchResultSchema],
    ['Candidate', CandidateSchema],
    ['GenerateResponse', GenerateResponseSchema],
    ['Status', StatusSchema],
    ['GenerateApiResponse', GenerateApiResponseSchema],
  ])('%s', (_name, schema) => {
    expect(z.toJSONSchema(schema)).toMatchSnapshot();
  });
});

describe('계약 검증', () => {
  const candidate = {
    answer: '안내드립니다.',
    approach: 'PROCEDURE_GUIDE',
    used_sources: ['S-0001'],
    assumptions: [],
  };

  it('정상 후보는 통과', () => {
    expect(CandidateSchema.parse(candidate)).toEqual(candidate);
  });

  it('필드 추가는 거부', () => {
    expect(() => CandidateSchema.parse({ ...candidate, content: 'x' })).toThrow();
  });

  it('필드 누락은 거부', () => {
    const { assumptions: _a, ...rest } = candidate;
    expect(() => CandidateSchema.parse(rest)).toThrow();
  });

  it('정의되지 않은 approach는 거부', () => {
    expect(() => CandidateSchema.parse({ ...candidate, approach: 'OTHER' })).toThrow();
  });

  it('insufficient_reason은 생략·null 허용', () => {
    expect(GenerateResponseSchema.parse({ candidates: [], is_info_sufficient: true })).toBeTruthy();
    expect(
      GenerateResponseSchema.parse({ candidates: [], is_info_sufficient: false, insufficient_reason: null }),
    ).toBeTruthy();
  });

  it.each(['S-0001', 'A-3f2a9c1e-uuid', 'K_0002', 'a'.repeat(50)])('source 형식 허용: %s', (s) => {
    expect(SOURCE_REGEX.test(s)).toBe(true);
  });

  it.each(['', 'S 0001', 'S/0001', '근거-1', 'a'.repeat(51)])('source 형식 거부: %s', (s) => {
    expect(SOURCE_REGEX.test(s)).toBe(false);
  });
});
