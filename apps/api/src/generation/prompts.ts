/**
 * 민원 답변 생성 — 시스템 프롬프트 및 출력 스키마 (실험 시 이 파일만 수정한다)
 *
 * 레거시 reference/python/prompts.py에서 가져왔다. backend-spec 4번이 허용한 용어 치환만 했다:
 *   selected_template_ids/selected_knowledge_ids → selected_sources, used_template_ids/used_knowledge_ids → used_sources,
 *   content → answer, "템플릿·지식" → "근거(과거 승인 답변)", resource_id → source,
 *   STAGE3의 assumptions 안내 문장 교체. 그 외 문구와 분량·형식 지시("5문장 이내" 등)는 그대로다.
 *
 * 실측 경고(architecture 5번): 분량·형식 지시를 시스템 프롬프트에서 빼고 description에만 두면
 * 답변 길이가 통제되지 않아 max_tokens에서 JSON이 잘렸다. 시스템 프롬프트와 description을 동시에 늘리지 말 것.
 *
 * 이 파일이 바뀌면 test/unit/prompts.spec.ts 스냅샷이 실패한다(의도한 변경일 때만 갱신).
 */
import type { Approach } from '@minwon/contracts';

export interface ApproachPreset {
  id: Approach;
  label: string;
  description: string;
}

export const APPROACH_PRESETS: readonly ApproachPreset[] = [
  { id: 'PROCEDURE_GUIDE', label: '절차 안내 중심', description: '민원인이 다음에 할 일이 명확할 때' },
  { id: 'ONSITE_CHECK', label: '현장 확인 일정 제시', description: '사실관계 확인이 선행돼야 할 때' },
  { id: 'IMMEDIATE_ACTION', label: '즉시 조치 안내', description: '이미 조치했거나 즉시 가능할 때' },
  { id: 'NOT_ELIGIBLE', label: '요건 미충족 안내', description: '요청을 수용할 수 없을 때' },
];

export function presetLines(): string {
  return APPROACH_PRESETS.map((p) => `- ${p.id} (${p.label}): ${p.description}`).join('\n');
}

export function presetIds(): Approach[] {
  return APPROACH_PRESETS.map((p) => p.id);
}

/**
 * source 배열 필드의 스키마. 후보가 있으면 enum으로 제한해 모델이 존재하지 않는 source를 지어내는 것을 막고,
 * 후보가 없으면 배열 자체를 비우도록 강제한다. (서버가 스키마를 강제하지 않는 경우를 위해 zod로도 같은 제한을 검증한다.)
 */
function idField(ids: string[], what: string): Record<string, unknown> {
  if (ids.length > 0) {
    return {
      type: 'array',
      items: { type: 'string', enum: ids },
      description: `${what} 중 실제로 답변 근거로 쓴 항목의 source. 후보 목록 밖의 값은 쓸 수 없다.`,
    };
  }
  return {
    type: 'array',
    maxItems: 0,
    items: { type: 'string' },
    description: `${what} 후보가 없으므로 항상 빈 배열.`,
  };
}

const EVIDENCE = '근거(과거 승인 답변)';

// ── 시스템 프롬프트 ─────────────────────────────────────────

export const COMMON_RULES = `# 역할
유성구청 민원 답변 작성자.

# 절대 규칙
1. **참고자료에 없는 내용은 쓰지 않는다.** 기간·부서·연락처를 추측하지 않는다.
2. **'유예 시간'은 단속을 하지 않는 시간이다.** 그 시간에 단속한다고 쓰지 않는다.
3. **자료의 일반 규정을 이 민원 장소에 단정 적용하지 않는다.**
4. **답변 본문만 출력한다.** 작업 과정이나 지시사항을 언급하지 않는다.
5. **한국어, JSON만 출력한다.**`;

export const STAGE1_SYSTEM =
  COMMON_RULES +
  `

## 현재 단계: 민원 분석
민원 원문을 읽고 답변에 필요한 정보가 갖춰졌는지 판정한다.

**할 일**
1. 민원인이 실제로 요구하는 것을 한 문장으로 정리한다. 불만 표출과 요구사항을 구분할 것.
2. 답변하려면 필요한데 민원 원문·참고자료 어디에도 없는 정보를 나열한다.
3. 그 정보 없이도 일반적 절차 안내로 답변 가능한지 판단한다.

**주의**: 민원인이 감정적으로 썼다고 정보가 부족한 것은 아니다.
그것 없이는 답변을 쓸 수 없는 경우만 부족으로 판정한다.`;

export const STAGE1_SCHEMA = {
  type: 'object',
  properties: {
    request_summary: {
      type: 'string',
      description:
        '민원인이 실제로 요구하는 것을 한 문장으로 정리. ' +
        "불만 표출(예: '너무 심하다')과 요구사항(예: '단속 강화')을 구분해 " +
        '요구사항만 적는다.',
    },
    missing_info: {
      type: 'array',
      items: { type: 'string' },
      description:
        '답변에 필요하지만 민원 원문과 참고자료 어디에도 없는 정보 항목. ' +
        "예: '해당 구간이 주민신고제 대상인지 여부', '발생 시각', '차량번호'. " +
        '민원인이 감정적으로 썼다는 것 자체는 정보 부족이 아니므로 포함하지 않는다. ' +
        '부족한 항목이 없으면 빈 배열.',
    },
    is_answerable: {
      type: 'boolean',
      description:
        'missing_info 없이도 일반적 절차 안내로 답변 가능하면 true. ' +
        'missing_info의 항목이 없으면 답변 자체를 쓸 수 없는 경우에만 false.',
    },
  },
  required: ['request_summary', 'missing_info', 'is_answerable'],
};

export const STAGE2_SYSTEM =
  COMMON_RULES +
  `

## 현재 단계: 근거 선별 및 접근 결정

**할 일**
1. ${EVIDENCE} 후보 중 이 민원과 직접 관련된 것만 선별한다. 후보에 있다는 이유로 억지로 쓰지 않는다.
2. 쓸 만한 자료가 없으면 selected_sources를 빈 배열로 둔다.
3. 아래 접근 유형 중 이 민원에 적합한 것을 1~3개 고른다. 서로 실질적으로 다른 것만 고르고,
   표현만 다른 조합은 금지한다.

**접근 유형**
${presetLines()}`;

/** 근거 선별 스키마. source 후보를 enum으로 넘겨받아 존재하지 않는 source를 지어내지 못하게 한다. */
export function stage2Schema(sources: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      selected_sources: idField(sources, EVIDENCE),
      approaches: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: { type: 'string', enum: presetIds() },
        description:
          '이 민원에 적합한 접근 유형 1~3개. 서로 실질적으로 다른 접근만 고르고, ' +
          '표현만 다른 조합은 금지한다. 접근 유형과 선택 기준:\n' +
          presetLines(),
      },
    },
    required: ['selected_sources', 'approaches'],
  };
}

export const STAGE3_SYSTEM =
  COMMON_RULES +
  `

## 현재 단계: 답변 작성
지정된 접근 유형에 맞춰 민원 답변을 작성한다.

**형식**
- 5문장 이내. 짧을수록 좋다.
- 공문 존댓말. 인사말은 첫 문장 하나만, 마무리 인사도 한 번만.
- 같은 말을 반복하지 않는다.

**접근 유형별 초점**
- PROCEDURE_GUIDE  : 민원인이 다음에 할 행동
- ONSITE_CHECK     : 현장 확인이 필요하다는 사실 (기간은 쓰지 않는다)
- IMMEDIATE_ACTION : 이미 완료된 사항
- NOT_ELIGIBLE     : 불가 사유

used_sources에는 답변의 근거로 쓴 자료의 source를 반드시 적는다.
assumptions에는 참고자료에 없는데 답변에 넣은 내용을 적는다. 없으면 빈 배열.
(assumptions는 검토자가 확인할 정보다.)`;

/** 답변 작성 스키마. 필드는 계약 Candidate 그대로(answer, approach, used_sources, assumptions). */
export function stage3Schema(sources: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      answer: {
        type: 'string',
        description:
          '민원인에게 발송할 답변 본문. 5문장 이내(짧을수록 좋음), 공문 존댓말. ' +
          '인사말은 첫 문장에 한 번만, 마무리 인사도 한 번만 쓰고 같은 말을 반복하지 않는다. ' +
          '접근 유형별 초점 — PROCEDURE_GUIDE: 민원인이 다음에 할 행동, ' +
          'ONSITE_CHECK: 현장 확인이 필요하다는 사실(기간은 쓰지 않음), ' +
          'IMMEDIATE_ACTION: 이미 완료된 사항, NOT_ELIGIBLE: 불가 사유.',
      },
      approach: {
        type: 'string',
        enum: presetIds(),
        description: '이 답변이 따른 접근 유형. 입력으로 지정된 접근 유형과 동일해야 한다.',
      },
      used_sources: idField(sources, EVIDENCE),
      assumptions: {
        type: 'array',
        items: { type: 'string' },
        description:
          '참고자료에 근거가 없는데 답변에 포함한 내용. ' +
          "예: '해당 도로가 주민신고제 구역이라고 가정함'. 없으면 빈 배열. " +
          '이 목록을 비우려고 문장을 삭제하지 말 것.',
      },
    },
    required: ['answer', 'approach', 'used_sources', 'assumptions'],
  };
}

// ── 사용자 메시지 ───────────────────────────────────────────

/** 컨텍스트 포맷: `[근거 — 과거 승인 답변]` 아래에 `- (source) content`. 검색 결과가 없으면 빈 문자열. */
export function formatContext(results: { source: string; content: string }[]): string {
  if (results.length === 0) return '';
  return ['[근거 — 과거 승인 답변]', ...results.map((r) => `- (${r.source}) ${r.content}`)].join('\n');
}

export function stage1User(complaint: string, context: string): string {
  return `[민원]
${complaint}

[참고자료]
${context}
`;
}

export function stage2User(complaint: string, context: string, requestSummary: string): string {
  return `[민원]
${complaint}

[민원 요구사항]
${requestSummary}

[참고자료]
${context}
`;
}

export function stage3User(complaint: string, context: string, approach: Approach, summary = ''): string {
  return `[민원]
${complaint}
${summary ? `[민원 요구사항]\n${summary}` : ''}
[참고자료]
${context}

[지정된 접근 유형]
${approach}
`;
}

/** json_schema 미지원 엔드포인트용 폴백: json_object 모드 + 스키마를 system 메시지로 명시 */
export function schemaHint(schema: Record<string, unknown>): string {
  return '다음 JSON 스키마를 따라 응답하라. 스키마에 없는 텍스트는 출력하지 않는다.\n' + JSON.stringify(schema);
}
