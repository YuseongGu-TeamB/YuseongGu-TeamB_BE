"""민원 답변 생성 — 미적용(baseline) / 적용(staged) 비교 실행

실행:
    python generate.py            # 3단계 전부 (로컬 ollama, qwen2.5:3b)
    python generate.py --stage3   # 3단계만 (시간 없을 때)
    python generate.py --compare qwen2.5:3b,qwen2.5:7b   # 모델 비교

모델/엔드포인트 전환:
    OPENAI_BASE_URL, OPENAI_API_KEY, MODEL 환경변수로 로컬 ollama /
    개발용 외부 고사양 모델을 코드 변경 없이 오갈 수 있다.
    기본값은 로컬 ollama(OpenAI Compatible API)다.

인터페이스 계약:
    검색 입출력과 답변 출력은 rag_search.interfaces에 정의된 계약
    (ComplaintSearchRequest/Response, GeneratedAnswer, AnswerGenerateResponse)을
    그대로 따른다. 아래 `search()`는 실제 SearchEngineImpl(ChromaDB+MySQL)
    연동 전까지 쓰는 mock이며, 반환 타입만 계약과 동일하게 맞춰뒀다 —
    나중에 이 함수 하나만 SearchEngineImpl.search로 바꿔 끼우면 된다.

결과는 output/ 아래 텍스트로 저장된다. 그대로 산출물로 제출.
"""

import json
import os
import sys
import time
from pathlib import Path

from openai import OpenAI
from rag_search import (
    AnswerGenerateRequest,
    AnswerGenerateResponse,
    ComplaintSearchRequest,
    ComplaintSearchResponse,
    GeneratedAnswer,
    KnowledgeCategory,
    ResourceType,
    ScoredResource,
)

import prompts

BASE_URL = os.environ.get("OPENAI_BASE_URL", "http://localhost:11434/v1")
API_KEY = os.environ.get("OPENAI_API_KEY", "ollama")
MODEL = os.environ.get("MODEL", "qwen2.5:3b")

# ollama 전용 옵션(keep_alive, num_ctx, num_thread)은 로컬 엔드포인트에서만 적용한다.
IS_LOCAL = "localhost" in BASE_URL or "127.0.0.1" in BASE_URL

OUT = Path("output")

client = OpenAI(base_url=BASE_URL, api_key=API_KEY)


# ── mock 검색 ──────────────────────────────────────────────
# 데이터 유입 방식이 미확정이므로 검색부는 고정 반환으로 대체한다.
# 반환 타입은 rag_search.ComplaintSearchResponse 계약을 그대로 따른다.

def search(request: ComplaintSearchRequest) -> ComplaintSearchResponse:
    return ComplaintSearchResponse(
        templates=[],
        related_knowledge=[
            ScoredResource(
                resource_id="K-0001",
                resource_type=ResourceType.KNOWLEDGE,
                category=KnowledgeCategory.PROCEDURE,
                title="저녁 유예 운영 안내",
                content="유성구는 지역경제 활성화를 위해 저녁 유예(19:00~22:00)를 운영합니다.",
                matched_text="저녁 유예",
                score=0.91,
            ),
            ScoredResource(
                resource_id="K-0002",
                resource_type=ResourceType.KNOWLEDGE,
                category=KnowledgeCategory.PROCEDURE,
                title="주민신고제 단속 안내",
                content="주민신고제 지역은 24시간 단속 대상입니다.",
                matched_text="주민신고제",
                score=0.87,
            ),
        ],
    )


COMPLAINT = {
    "complaintId": "C-2024_001",
    "title": "지족로364번길 불법주정차 단속 요청",
    "content": "지족로364번길에 불법주정차가 너무 심합니다. 단속 강화해주세요",
    "category": "불법주정차",
}


def format_context(templates: list[ScoredResource], knowledge: list[ScoredResource]) -> str:
    lines = []
    if templates:
        lines.append("[템플릿 — 과거 유사 답변]")
        lines += [f"- ({r.resource_id}) {r.content}" for r in templates]
    if knowledge:
        lines.append("[지식 — 법령·조례·절차]")
        lines += [f"- ({r.resource_id}) {r.content}" for r in knowledge]
    return "\n".join(lines)


def call(
    system: str | None,
    user: str,
    schema: dict,
    model: str = MODEL,
    max_tokens: int = 250,   # 5문장이면 충분. 폭주 방지
    temperature: float = 0.3,  # 공문이므로 낮게. 재생성 편차도 줄어든다
    metrics: list | None = None,
) -> dict:
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user})

    extra_body = {}
    if IS_LOCAL:
        extra_body = {
            "keep_alive": -1,   # 모델을 메모리에 상주시킨다.
                                # 담당자가 붙여넣을 때마다 재로딩되면
                                # 그 자체로 10초 이상이 나간다.
            "options": {
                "num_ctx": 2048,    # 참고자료가 짧으므로 기본값보다 낮춘다
                "num_thread": 4,    # 전 코어를 먹으면 DB·JVM이 굶는다
            },
        }

    t0 = time.perf_counter()
    try:
        res = client.chat.completions.create(
            model=model,
            messages=messages,
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "response", "schema": schema, "strict": True},
            },
            max_tokens=max_tokens,
            temperature=temperature,
            extra_body=extra_body or None,
        )
    except Exception:
        # 엔드포인트가 json_schema를 지원하지 않을 때의 폴백:
        # json_object 모드 + 스키마를 프롬프트에 직접 명시한다.
        schema_hint = {
            "role": "system",
            "content": (
                "다음 JSON 스키마를 따라 응답하라. 스키마에 없는 텍스트는 출력하지 않는다.\n"
                + json.dumps(schema, ensure_ascii=False)
            ),
        }
        res = client.chat.completions.create(
            model=model,
            messages=[schema_hint] + messages,
            response_format={"type": "json_object"},
            max_tokens=max_tokens,
            temperature=temperature,
            extra_body=extra_body or None,
        )
    elapsed = time.perf_counter() - t0

    tokens = res.usage.completion_tokens if res.usage else None
    if tokens:
        print(f"    [{tokens} tokens / {elapsed:.1f}s = {tokens/elapsed:.1f} tok/s]")
    if metrics is not None:
        metrics.append({"tokens": tokens, "elapsed": elapsed})

    return json.loads(res.choices[0].message.content)


# ── 미적용 (baseline) ──────────────────────────────────────
# 계약과 무관한 내부 비교용 경로. prompts.BASELINE_SCHEMA 참고.

def run_baseline(complaint_text: str, context: str, model: str = MODEL, metrics: list | None = None) -> dict:
    user = f"""아래 참고자료를 바탕으로 민원에 대한 답변을 작성해줘.

[민원]
{complaint_text}

[참고자료]
{context}
"""
    return call(None, user, prompts.BASELINE_SCHEMA, model=model, metrics=metrics)


# ── 적용 (단계별) ──────────────────────────────────────────

def run_stage1(complaint_text: str, context: str, model: str = MODEL, metrics: list | None = None) -> dict:
    user = f"""[민원]
{complaint_text}

[참고자료]
{context}
"""
    system = prompts.system_for("stage1", model)
    return call(system, user, prompts.STAGE1_SCHEMA, model=model, metrics=metrics)


def run_stage2(
    complaint_text: str,
    context: str,
    s1: dict,
    template_ids: list[str],
    knowledge_ids: list[str],
    model: str = MODEL,
    metrics: list | None = None,
) -> dict:
    user = f"""[민원]
{complaint_text}

[민원 요구사항]
{s1['request_summary']}

[참고자료]
{context}
"""
    system = prompts.system_for("stage2", model)
    schema = prompts.stage2_schema(template_ids, knowledge_ids)
    return call(system, user, schema, model=model, metrics=metrics)


def run_stage3(
    complaint_text: str,
    context: str,
    approach: str,
    template_ids: list[str],
    knowledge_ids: list[str],
    summary: str = "",
    model: str = MODEL,
    metrics: list | None = None,
) -> dict:
    user = f"""[민원]
{complaint_text}
{f"[민원 요구사항]{chr(10)}{summary}" if summary else ""}
[참고자료]
{context}

[지정된 접근 유형]
{approach}
"""
    system = prompts.system_for("stage3", model)
    schema = prompts.stage3_schema(template_ids, knowledge_ids)
    return call(system, user, schema, model=model, metrics=metrics)


def to_generated_answer(s3: dict) -> GeneratedAnswer:
    """stage3 원본 출력을 계약 타입으로 변환한다.

    `assumptions`는 GeneratedAnswer 계약에 없는 필드라 여기서 제외한다 —
    호출부에서 s3["assumptions"]를 검토용 로그로 따로 남길 것.
    """
    return GeneratedAnswer(
        content=s3["content"],
        approach=s3["approach"],
        used_template_ids=s3["used_template_ids"],
        used_knowledge_ids=s3["used_knowledge_ids"],
    )


def generate_answer(
    request: AnswerGenerateRequest,
    model: str = MODEL,
    metrics: list | None = None,
) -> AnswerGenerateResponse:
    """rag_search.AnswerGenerator 계약과 같은 모양(요청 → 응답)의 진입점.

    내부적으로 1~3단계 파이프라인을 순서대로 돌린다 — 이 내부 구조는
    계약이 아니므로 자유롭게 바꿔도 된다. 계약은 이 함수의 입출력 타입뿐이다.
    """
    template_ids = [r.resource_id for r in request.templates]
    knowledge_ids = [r.resource_id for r in request.related_knowledge]
    context = format_context(request.templates, request.related_knowledge)

    s1 = run_stage1(request.complaint_text, context, model=model, metrics=metrics)
    s2 = run_stage2(
        request.complaint_text, context, s1, template_ids, knowledge_ids,
        model=model, metrics=metrics,
    )
    approaches = s2["approaches"] or ["PROCEDURE_GUIDE"]

    answers = []
    for ap in approaches:
        s3 = run_stage3(
            request.complaint_text, context, ap, template_ids, knowledge_ids,
            summary=s1["request_summary"], model=model, metrics=metrics,
        )
        answers.append(to_generated_answer(s3))
        if s3["assumptions"]:
            print(f"    [assumptions — 계약 필드 아님, 검토용] ({ap}): {s3['assumptions']}")

    return AnswerGenerateResponse(
        answers=answers,
        is_info_sufficient=s1["is_answerable"],
        insufficient_reason="; ".join(s1["missing_info"]) if s1["missing_info"] else None,
    )


# ── 모델 비교 ────────────────────────────────────────────────
# 최소 서비스 모델 스펙을 데이터로 결정하기 위해, 동일 민원·동일 자료(mock)로
# 여러 모델을 순차 실행하고 토큰 수·소요 시간·답변을 나란히 남긴다.

def run_pipeline_for_model(complaint_text: str, search_response: ComplaintSearchResponse, model: str) -> dict:
    metrics: list = []
    request = AnswerGenerateRequest(
        complaint_text=complaint_text,
        templates=search_response.templates,
        related_knowledge=search_response.related_knowledge,
    )
    response = generate_answer(request, model=model, metrics=metrics)

    total_tokens = sum(m["tokens"] for m in metrics if m["tokens"])
    total_time = sum(m["elapsed"] for m in metrics)
    return {
        "model": model,
        "total_tokens": total_tokens,
        "total_time": total_time,
        "tok_s": total_tokens / total_time if total_time else 0.0,
        "response": response,
    }


def compare_models(models: list[str], complaint=COMPLAINT, out_path: Path = None) -> list[dict]:
    out_path = out_path or (OUT / "model_comparison.md")
    complaint_text = f"{complaint['title']}\n{complaint['content']}"
    search_response = search(ComplaintSearchRequest(text=complaint["content"]))

    results = []
    for model in models:
        print("\n" + "=" * 60)
        print(f"[비교] 모델: {model}")
        print("=" * 60)
        results.append(run_pipeline_for_model(complaint_text, search_response, model))

    lines = ["# 모델 비교 결과", "", "| 모델 | 총 토큰 | 총 시간(s) | tok/s |", "|---|---|---|---|"]
    for r in results:
        lines.append(f"| {r['model']} | {r['total_tokens']} | {r['total_time']:.1f} | {r['tok_s']:.1f} |")

    for r in results:
        lines += ["", f"## {r['model']}", ""]
        for ans in r["response"].answers:
            lines += [
                f"### 접근: {ans.approach}", "",
                ans.content, "",
                f"사용 템플릿: {ans.used_template_ids}",
                f"사용 지식: {ans.used_knowledge_ids}",
                "",
            ]

    OUT.mkdir(exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n비교 결과 저장: {out_path}")
    return results


# ── 실행 ───────────────────────────────────────────────────

def main():
    argv = sys.argv[1:]
    OUT.mkdir(exist_ok=True)

    if "--compare" in argv:
        idx = argv.index("--compare")
        models = argv[idx + 1].split(",") if idx + 1 < len(argv) and not argv[idx + 1].startswith("--") else ["qwen2.5:3b", "qwen2.5:7b"]
        compare_models([m.strip() for m in models])
        return

    stage3_only = "--stage3" in argv

    complaint_text = f"{COMPLAINT['title']}\n{COMPLAINT['content']}"
    search_response = search(ComplaintSearchRequest(text=COMPLAINT["content"]))
    template_ids = [r.resource_id for r in search_response.templates]
    knowledge_ids = [r.resource_id for r in search_response.related_knowledge]
    context = format_context(search_response.templates, search_response.related_knowledge)

    # 1) 미적용 (계약과 무관한 비교용 경로)
    print("=" * 60)
    print("[미적용] 시스템 프롬프트 없음")
    print("=" * 60)
    base = run_baseline(complaint_text, context)
    print("답변:", base["answer"])
    print("정보 충분?:", base["is_info_sufficient"])
    print("사용 출처:", base["used_sources"])

    lines = ["[미적용 — 시스템 프롬프트 없음]", "",
             base["answer"], "",
             f"정보 충분?: {base['is_info_sufficient']}",
             f"사용 출처: {base['used_sources']}"]
    (OUT / "baseline.txt").write_text("\n".join(lines), encoding="utf-8")

    # 2) 적용 — GeneratedAnswer/AnswerGenerateResponse 계약을 따른다.
    summary = ""
    approaches = ["PROCEDURE_GUIDE"]

    if stage3_only:
        applied = []
        for ap in approaches:
            s3 = run_stage3(complaint_text, context, ap, template_ids, knowledge_ids, summary)
            applied.append(to_generated_answer(s3))
            print(f"\n--- {ap} ---")
            print("답변:", s3["content"])
            print("가정:", s3["assumptions"] or "없음")
            print("사용 템플릿/지식:", s3["used_template_ids"], s3["used_knowledge_ids"])
        response = AnswerGenerateResponse(answers=applied, is_info_sufficient=True)
    else:
        print("\n" + "=" * 60)
        print("[적용] 1~3단계 파이프라인")
        print("=" * 60)
        request = AnswerGenerateRequest(
            complaint_text=complaint_text,
            templates=search_response.templates,
            related_knowledge=search_response.related_knowledge,
        )
        response = generate_answer(request)
        for ans in response.answers:
            print(f"\n--- {ans.approach} ---")
            print("답변:", ans.content)
            print("사용 템플릿/지식:", ans.used_template_ids, ans.used_knowledge_ids)
        if not response.is_info_sufficient:
            print("\n>> 정보 부족으로 생성 중단. 담당자 확인 필요:", response.insufficient_reason)

    out = ["[적용 — 단계별 시스템 프롬프트]", ""]
    for ans in response.answers:
        out += [f"### 접근: {ans.approach}", "",
                ans.content, "",
                f"사용 템플릿: {ans.used_template_ids}",
                f"사용 지식: {ans.used_knowledge_ids}",
                f"정보 충분?: {response.is_info_sufficient}", "", "-" * 40, ""]
    (OUT / "applied.txt").write_text("\n".join(out), encoding="utf-8")

    print(f"\n저장 완료: {OUT/'baseline.txt'}, {OUT/'applied.txt'}")


if __name__ == "__main__":
    main()
