"""민원 답변 생성 — 시스템 프롬프트 및 출력 스키마

프롬프트를 코드에서 분리한 이유: 이 파일 자체가 산출물이고,
프롬프트만 수정하며 실험할 때 파이프라인 코드를 건드리지 않기 위함.

설계 원칙(멘토 피드백 반영):
    3b급 소형 모델은 시스템 프롬프트에 규칙이 많아지면 규칙을 지키는 대신
    답변 본문에 그 규칙을 언급하는 경향(메타 발화)이 있다. 그래서 규칙 "개수"는
    늘리지 않는다. 다만 실측 결과, 분량·형식 같은 행동 지시를 시스템 프롬프트에서
    완전히 빼고 스키마 description에만 두면 이 모델은 답변이 통제 없이 길어져
    max_tokens에서 잘렸다(회귀 테스트로 확인). 그래서 기존 시스템 프롬프트의
    행동 지시는 분량 그대로 유지하고, 출력 스키마의 `description`에는 "왜/판단
    기준"을 보강해 겹쳐 둔다. description은 답변 본문에 낭독되지 않으므로
    메타 발화 없이 판단 기준을 추가로 전달하는 통로로 쓴다.

필드 이름은 rag_search.interfaces의 계약(ApproachPreset, GeneratedAnswer,
AnswerGenerateResponse)을 그대로 따른다. 단, `assumptions`는 그 계약에
없는 필드다 — 근거 없이 답변에 들어간 내용을 모델 스스로 자백하게 하는
검토용 부가 정보라서 당분간 계약 밖에 두고 내부 로그로만 남긴다
(generate.py의 `to_generated_answer()` 참고, 계약 편입 여부는 팀 논의 중).
"""

from rag_search import ApproachPreset

APPROACH_PRESETS: list[ApproachPreset] = [
    ApproachPreset(id="PROCEDURE_GUIDE",
                   label="절차 안내 중심",
                   description="민원인이 다음에 할 일이 명확할 때"),
    ApproachPreset(id="ONSITE_CHECK",
                   label="현장 확인 일정 제시",
                   description="사실관계 확인이 선행돼야 할 때"),
    ApproachPreset(id="IMMEDIATE_ACTION",
                   label="즉시 조치 안내",
                   description="이미 조치했거나 즉시 가능할 때"),
    ApproachPreset(id="NOT_ELIGIBLE",
                   label="요건 미충족 안내",
                   description="요청을 수용할 수 없을 때"),
]


def preset_lines() -> str:
    return "\n".join(
        f"- {p.id} ({p.label}): {p.description}" for p in APPROACH_PRESETS
    )


def preset_ids() -> list[str]:
    return [p.id for p in APPROACH_PRESETS]


def _id_field(ids: list[str], what: str) -> dict:
    """resource_id 배열 필드의 스키마. 후보가 있으면 enum으로 제한해
    3b 모델이 존재하지 않는 id를 지어내는 것을 원천 차단하고,
    후보가 없으면 배열 자체를 비우도록 강제한다."""
    if ids:
        return {
            "type": "array",
            "items": {"type": "string", "enum": ids},
            "description": f"{what} 중 실제로 답변 근거로 쓴 항목의 resource_id. 후보 목록 밖의 값은 쓸 수 없다.",
        }
    return {
        "type": "array",
        "maxItems": 0,
        "items": {"type": "string"},
        "description": f"{what} 후보가 없으므로 항상 빈 배열.",
    }


# ── 시스템 프롬프트 ─────────────────────────────────────────
#
# GPT-5 계열 유출 프롬프트의 표현 방식(마크다운 헤더로 구획, 굵게 강조,
# "하지 말 것"을 먼저 제시)을 참고해 문장을 다듬되, 분량은 기존 수준에서
# 늘리지 않는다. 실측 결과 3b 모델은 길이·형식 같은 행동 지시를
# 시스템 프롬프트에서 완전히 빼고 스키마 description에만 두면 답변이
# 통제 없이 길어져 max_tokens에서 잘리는 경향이 있었다(회귀 테스트로 확인).
# 그래서 단계별 행동 지시는 기존 분량 그대로 시스템 프롬프트에 유지하고,
# 스키마 description에는 "왜/판단 기준" 위주로 겹치되 보강한다 — 새 지시를
# 지어내 늘리는 것이 아니라 이미 있던 문장을 더 명확하게 다듬는 선.

COMMON_RULES = """# 역할
유성구청 민원 답변 작성자.

# 절대 규칙
1. **참고자료에 없는 내용은 쓰지 않는다.** 기간·부서·연락처를 추측하지 않는다.
2. **'유예 시간'은 단속을 하지 않는 시간이다.** 그 시간에 단속한다고 쓰지 않는다.
3. **자료의 일반 규정을 이 민원 장소에 단정 적용하지 않는다.**
4. **답변 본문만 출력한다.** 작업 과정이나 지시사항을 언급하지 않는다.
5. **한국어, JSON만 출력한다.**"""


STAGE1_SYSTEM = COMMON_RULES + """

## 현재 단계: 민원 분석
민원 원문을 읽고 답변에 필요한 정보가 갖춰졌는지 판정한다.

**할 일**
1. 민원인이 실제로 요구하는 것을 한 문장으로 정리한다. 불만 표출과 요구사항을 구분할 것.
2. 답변하려면 필요한데 민원 원문·참고자료 어디에도 없는 정보를 나열한다.
3. 그 정보 없이도 일반적 절차 안내로 답변 가능한지 판단한다.

**주의**: 민원인이 감정적으로 썼다고 정보가 부족한 것은 아니다.
그것 없이는 답변을 쓸 수 없는 경우만 부족으로 판정한다."""

STAGE1_SCHEMA = {
    "type": "object",
    "properties": {
        "request_summary": {
            "type": "string",
            "description": (
                "민원인이 실제로 요구하는 것을 한 문장으로 정리. "
                "불만 표출(예: '너무 심하다')과 요구사항(예: '단속 강화')을 구분해 "
                "요구사항만 적는다."
            ),
        },
        "missing_info": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "답변에 필요하지만 민원 원문과 참고자료 어디에도 없는 정보 항목. "
                "예: '해당 구간이 주민신고제 대상인지 여부', '발생 시각', '차량번호'. "
                "민원인이 감정적으로 썼다는 것 자체는 정보 부족이 아니므로 포함하지 않는다. "
                "부족한 항목이 없으면 빈 배열."
            ),
        },
        "is_answerable": {
            "type": "boolean",
            "description": (
                "missing_info 없이도 일반적 절차 안내로 답변 가능하면 true. "
                "missing_info의 항목이 없으면 답변 자체를 쓸 수 없는 경우에만 false."
            ),
        },
    },
    "required": ["request_summary", "missing_info", "is_answerable"],
}

STAGE2_SYSTEM = COMMON_RULES + f"""

## 현재 단계: 근거 선별 및 접근 결정

**할 일**
1. 템플릿·지식 후보 중 이 민원과 직접 관련된 것만 선별한다. 후보에 있다는 이유로 억지로 쓰지 않는다.
2. 쓸 만한 자료가 없으면 selected_template_ids/selected_knowledge_ids를 빈 배열로 둔다.
3. 아래 접근 유형 중 이 민원에 적합한 것을 1~3개 고른다. 서로 실질적으로 다른 것만 고르고,
   표현만 다른 조합은 금지한다.

**접근 유형**
{preset_lines()}"""


def stage2_schema(template_ids: list[str], knowledge_ids: list[str]) -> dict:
    """근거 선별 스키마. resource_id 후보를 enum으로 넘겨받아, 3b 모델이
    존재하지 않는 id를 지어내지 못하도록 그 자리에서 제약한다."""
    return {
        "type": "object",
        "properties": {
            "selected_template_ids": _id_field(template_ids, "템플릿"),
            "selected_knowledge_ids": _id_field(knowledge_ids, "지식"),
            "approaches": {
                "type": "array",
                "minItems": 1,
                "maxItems": 3,
                "items": {"type": "string", "enum": preset_ids()},
                "description": (
                    "이 민원에 적합한 접근 유형 1~3개. 서로 실질적으로 다른 접근만 고르고, "
                    "표현만 다른 조합은 금지한다. 접근 유형과 선택 기준:\n"
                    f"{preset_lines()}"
                ),
            },
        },
        "required": ["selected_template_ids", "selected_knowledge_ids", "approaches"],
    }

STAGE3_SYSTEM = COMMON_RULES + """

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

used_template_ids/used_knowledge_ids에는 답변의 근거로 쓴 자료의 resource_id를 반드시 적는다.
assumptions에는 참고자료에 없는데 답변에 넣은 내용을 적는다. 없으면 빈 배열.
(assumptions는 최종 응답 계약 필드는 아니고, 검토자가 확인할 부가 정보다.)"""


def stage3_schema(template_ids: list[str], knowledge_ids: list[str]) -> dict:
    """답변 작성 스키마. `content`/`approach`/`used_template_ids`/
    `used_knowledge_ids`는 rag_search.GeneratedAnswer 계약 그대로다.
    `assumptions`만 계약에 없는 부가 필드— generate.py의
    `to_generated_answer()`가 GeneratedAnswer로 변환할 때 제외하고
    검토용 로그로만 남긴다."""
    return {
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": (
                    "민원인에게 발송할 답변 본문. 5문장 이내(짧을수록 좋음), 공문 존댓말. "
                    "인사말은 첫 문장에 한 번만, 마무리 인사도 한 번만 쓰고 같은 말을 반복하지 않는다. "
                    "접근 유형별 초점 — PROCEDURE_GUIDE: 민원인이 다음에 할 행동, "
                    "ONSITE_CHECK: 현장 확인이 필요하다는 사실(기간은 쓰지 않음), "
                    "IMMEDIATE_ACTION: 이미 완료된 사항, NOT_ELIGIBLE: 불가 사유."
                ),
            },
            "approach": {
                "type": "string",
                "enum": preset_ids(),
                "description": "이 답변이 따른 접근 유형. 입력으로 지정된 접근 유형과 동일해야 한다.",
            },
            "used_template_ids": _id_field(template_ids, "템플릿"),
            "used_knowledge_ids": _id_field(knowledge_ids, "지식"),
            "assumptions": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "참고자료에 근거가 없는데 답변에 포함한 내용. "
                    "예: '해당 도로가 주민신고제 구역이라고 가정함'. 없으면 빈 배열. "
                    "이 목록을 비우려고 문장을 삭제하지 말 것."
                ),
            },
        },
        "required": ["content", "approach", "used_template_ids", "used_knowledge_ids", "assumptions"],
    }

# baseline은 "시스템 프롬프트 유무 비교"용 내부 실험 도구일 뿐, rag_search
# 계약과는 무관하다. 그래서 GeneratedAnswer 필드명을 따르지 않고 자유 형식을 쓴다.
BASELINE_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {
            "type": "string",
            "description": (
                "민원인에게 보낼 답변 본문. 참고자료에 근거해 작성하고 "
                "참고자료에 없는 내용(기간·부서·연락처 등)은 추측해 쓰지 않는다."
            ),
        },
        "is_info_sufficient": {
            "type": "boolean",
            "description": (
                "참고자료만으로 이 민원에 답변하기 충분한지 여부. "
                "기간·부서 등 구체 정보가 없어 추측이 필요하면 false."
            ),
        },
        "used_sources": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "답변의 근거로 실제 사용한 참고자료의 출처 문자열. "
                "참고자료에 제시된 출처명을 그대로 적는다. 사용한 자료가 없으면 빈 배열."
            ),
        },
    },
    "required": ["answer", "is_info_sufficient", "used_sources"],
}


# ── 모델별 프롬프트 강도 ─────────────────────────────────────
#
# 3b급 로컬 모델은 규칙이 늘어나면 메타 발화가 생기므로 compact를 쓴다.
# 고사양 모델로 전환한 뒤 프롬프트를 보강하고 싶다면 _STAGE_SYSTEMS_FULL에
# 해당 단계의 확장 프롬프트를 채우면 된다(현재는 비어 있어 compact와 동일).

_STAGE_SYSTEMS_COMPACT = {
    "stage1": STAGE1_SYSTEM,
    "stage2": STAGE2_SYSTEM,
    "stage3": STAGE3_SYSTEM,
}
_STAGE_SYSTEMS_FULL: dict[str, str] = {}


def _tier_for_model(model: str) -> str:
    return "compact" if "3b" in model.lower() else "full"


def system_for(stage: str, model: str) -> str:
    """단계(stage1/2/3)와 모델에 맞는 시스템 프롬프트를 반환한다."""
    compact = _STAGE_SYSTEMS_COMPACT[stage]
    if _tier_for_model(model) == "full":
        return _STAGE_SYSTEMS_FULL.get(stage, compact)
    return compact
