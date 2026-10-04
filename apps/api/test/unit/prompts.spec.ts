import * as P from '../../src/generation/prompts';

/**
 * 프롬프트 스냅샷: prompts.ts의 시스템 프롬프트·스키마·사용자 메시지 형식이 바뀌면 실패한다.
 * 의도한 변경일 때만 `jest -u`로 갱신할 것(architecture 6번 체크리스트).
 */
describe('프롬프트 스냅샷', () => {
  it('시스템 프롬프트', () => {
    expect({
      COMMON_RULES: P.COMMON_RULES,
      STAGE1_SYSTEM: P.STAGE1_SYSTEM,
      STAGE2_SYSTEM: P.STAGE2_SYSTEM,
      STAGE3_SYSTEM: P.STAGE3_SYSTEM,
    }).toMatchSnapshot();
  });

  it('스키마 (근거 있음 / 없음)', () => {
    expect({
      STAGE1_SCHEMA: P.STAGE1_SCHEMA,
      stage2WithSources: P.stage2Schema(['K-0001', 'K-0002']),
      stage2NoSources: P.stage2Schema([]),
      stage3WithSources: P.stage3Schema(['K-0001', 'K-0002']),
      stage3NoSources: P.stage3Schema([]),
    }).toMatchSnapshot();
  });

  it('사용자 메시지·컨텍스트·폴백 문구', () => {
    const ctx = P.formatContext([
      { source: 'K-0001', content: '저녁 유예 안내' },
      { source: 'S-0001', content: '과거 답변' },
    ]);
    expect({
      context: ctx,
      emptyContext: P.formatContext([]),
      stage1: P.stage1User('민원 본문', ctx),
      stage2: P.stage2User('민원 본문', ctx, '요구 요약'),
      stage3: P.stage3User('민원 본문', ctx, 'ONSITE_CHECK', '요구 요약'),
      stage3NoSummary: P.stage3User('민원 본문', ctx, 'ONSITE_CHECK'),
      hint: P.schemaHint({ type: 'object' }),
    }).toMatchSnapshot();
  });
});

describe('스펙이 정한 문구 (스냅샷과 별개로 고정)', () => {
  it('분량·형식 지시는 시스템 프롬프트와 description 양쪽에 남아 있다', () => {
    expect(P.STAGE3_SYSTEM).toContain('5문장 이내. 짧을수록 좋다.');
    expect(JSON.stringify(P.stage3Schema([]))).toContain('5문장 이내(짧을수록 좋음)');
  });

  it('assumptions 문구는 스펙 4번대로 교체됐다', () => {
    expect(P.STAGE3_SYSTEM).toContain('(assumptions는 검토자가 확인할 정보다.)');
    expect(P.STAGE3_SYSTEM).not.toContain('계약 필드는 아니고');
    expect(JSON.stringify(P.stage3Schema([]))).toContain('이 목록을 비우려고 문장을 삭제하지 말 것.');
  });

  it('레거시 용어가 남아 있지 않다', () => {
    const all = [
      P.STAGE1_SYSTEM,
      P.STAGE2_SYSTEM,
      P.STAGE3_SYSTEM,
      JSON.stringify([P.stage2Schema(['a']), P.stage3Schema(['a'])]),
    ].join('\n');
    for (const legacy of ['template', 'knowledge', '템플릿', 'resource_id', '"content"']) {
      expect(all).not.toContain(legacy);
    }
  });

  it('컨텍스트 포맷은 [근거 — 과거 승인 답변] + - (source) content', () => {
    expect(P.formatContext([{ source: 'S-0001', content: '내용' }])).toBe('[근거 — 과거 승인 답변]\n- (S-0001) 내용');
  });

  it('스키마 필드는 계약 필드와 같다', () => {
    expect((P.stage3Schema([]) as { required: string[] }).required).toEqual([
      'answer',
      'approach',
      'used_sources',
      'assumptions',
    ]);
  });
});
