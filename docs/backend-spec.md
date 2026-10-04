# 백엔드 요구사항 (최종 · 시연용 / NestJS + TypeScript)

## 0. 기준과 범위
- **기준은 아키텍처 문서(`docs/architecture.*`)다.** 새 NestJS 프로젝트를 **처음부터** 만든다. 기존 Python 코드는 이식 대상이 아니라 레거시 참고 자료다.
  아래 4번의 "가져올 것"(프롬프트 노하우, 접근 유형 프리셋 등)만 참고하고, 코드 구조는 따르지 않는다.
  `rag_search` 패키지와 `ScoredResource`, 템플릿/지식 이중 구조는 사용하지 않는다.
- 목표는 **시연 성공**. 시연에서 증명할 것은 세 가지다.
  1. 민원을 넣으면 답변 후보가 생성되고, 발송된 답변이 다시 근거로 쌓인다.
  2. **임베딩·벡터DB·RDB·API는 GPU 없는 개발 PC에서 로컬로** 돈다.
  3. 생성 LLM은 OpenAI 호환 엔드포인트라 로컬 ollama든 외부 서버든 **설정만으로** 바뀐다.
     개발 PC에 GPU가 없어 시연에서는 **Ollama 클라우드의 `gemma4:31b`**를 쓴다. 개발 중에는 로컬 `qwen2.5:7b`. `.env`의 `MODEL`(과 엔드포인트)만 바꿔 전환한다.
     모델 크기 비교는 하지 않는다(3b·7b의 한계는 레거시 Python 실험에서 이미 확인, 6-3).
  분석 화면·분석 API는 만들지 않는다. 인증, 다중 사용자, 운영 배포, 성능 최적화는 범위 밖.
- 운영 서버 OS는 미정이며 **Linux를 기본 가정**한다. Windows 대응은 README 메모 수준으로만 둔다.
- 참고용 원본(`generate.py`, `prompts.py`)은 `reference/python/`에 있으며 읽기 전용이다.
- 시드 답변은 **Excel 파일로 넣을 수 있어야 한다**(6-2 개발자용 시드 API).
- 이 문서와 아키텍처 문서가 충돌하면 작업을 멈추고 질문한다. 이 문서에 없는 결정이 필요해도 임의로 정하지 말고 질문한다.

## 1. 프로젝트 구조와 기술 선택
```
apps/api          NestJS 백엔드 (이 문서의 범위)
apps/desktop      Electron + React (별도 문서, 지금은 만들지 않음)
packages/contracts 계약 스키마(zod) + TS 타입. api와 desktop이 함께 import
docs/             이 문서, 아키텍처 문서
reference/python/ 레거시 참고 코드 (수정 금지)
```
- 패키지 매니저: pnpm workspaces. Node LTS. 테스트: Jest(Nest 기본).
- DB: **PostgreSQL + pgvector** 하나로 RDB와 벡터DB를 함께 운영한다(5번). ORM은 Prisma.
  - 이 시스템의 목적은 **로컬 서버에서 벡터DB가 돌아가고, 발송 답변이 쌓여 데이터로 해석 가능함**을 보이는 것이다.
  - pgvector를 고른 이유: (1) 상태 전이(`sent`)와 임베딩 추가를 **한 트랜잭션**으로 묶어 핵심 불변식을 DB 수준에서 보장할 수 있다.
    (2) 민원·답변·상태·벡터가 한 곳에 있어 SQL로 바로 집계·분석할 수 있다. (3) GPU 없이 CPU·16GB급 서버에서도 가볍게 돈다.
    (4) Node 생태계(Prisma, `pgvector` npm 패키지)에서 바로 쓸 수 있고 Python 프로세스가 필요 없다.
  - Prisma를 고른 이유: 스키마가 `schema.prisma` 한 파일에 모여 AI가 바꾼 부분을 diff로 확인하기 쉽고, 생성된 타입이 엄격해
    필드명이 바뀌면 컴파일 에러로 드러난다. 마이그레이션도 명령 하나로 관리된다. 벡터 컬럼은 Prisma가 직접 다루지 못하므로
    `Unsupported("vector(N)")`로 선언하고, 벡터 쓰기·검색만 `$queryRaw`/`$executeRaw`를 쓰는 리포지토리 한 곳에 모은다.
  - 로컬 실행: `docker-compose.yml`에 `pgvector/pgvector` 이미지를 둔다. Docker 없이 설치하는 방법(Linux 패키지, Windows 빌드)은
    README에 따로 적는다(운영 서버 OS가 미정이므로).
- LLM 클라이언트: npm `openai` 패키지(OpenAI 호환 규격).
- Excel: `exceljs`.
- `.env.example`에 모든 환경변수와 기본값, 한 줄 설명을 둔다.
- Electron 렌더러에서 호출할 수 있도록 CORS를 허용한다(허용 origin은 환경변수 `CORS_ORIGINS`).

## 2. 변경 금지 계약 (packages/contracts, zod 스키마 + TS 타입을 한 곳에서만 정의)

```ts
// 검색 계약
search(query: string, top_k: number): Promise<{ content: string; source: string }[]>

// 답변 후보 1개 (생성 출력 고정 JSON)
Candidate { answer: string; approach: Approach; used_sources: string[]; assumptions: string[] }
Approach = 'PROCEDURE_GUIDE' | 'ONSITE_CHECK' | 'IMMEDIATE_ACTION' | 'NOT_ELIGIBLE'

// 생성 결과
GenerateResponse { candidates: Candidate[]; is_info_sufficient: boolean; insufficient_reason?: string | null }
```

- `source`는 코퍼스 항목마다 **고유한 문자열**. 형식: 영문·숫자·`-`·`_`, 최대 50자.
  시드 자동 부여는 `S-0001`, 발송으로 추가된 답변은 `A-<민원 id>`.
- `used_sources`의 값은 반드시 **이번 검색 결과의 `source` 중에서만** 나온다(생성 스키마에서 `enum`으로 제한. 검색 결과가 없으면 `maxItems: 0`).
- 필드명 변경·추가·삭제 금지. API, DB, 데스크톱 모두 `packages/contracts`를 import한다.
- OpenAI 호환 요청 형태(`messages`, `response_format`)를 유지한다. 모델 교체는 환경변수만으로.
- **계약 밖 정보는 API 응답의 바깥 봉투에 둔다.** 계약 타입에 필드를 끼워 넣지 않는다. 예:
  ```ts
  GenerateApiResponse {
    complaint_id: string;
    status: Status;
    model: string;                                  // 이번 생성에 쓴 모델(= MODEL)
    result: GenerateResponse;                       // 계약 그대로
    drafts: { draft_id: string; approach: Approach }[]; // 후보와 같은 순서, PATCH용 id
    failed: { approach: Approach; reason: string }[];   // 생성 실패 후보
    timings: { stage: string; ms: number; tokens?: number }[];
  }
  ```

## 3. 상태와 불변식
- 상태: `received → draft → approved → sent`만 허용. 건너뛰기·역행 금지.
  예외: **`draft → draft` 재생성**은 허용(기존 후보는 `superseded`로 보관하고 새 후보 저장).
- 상태를 바꾸는 함수는 **하나만** 두고 모든 경로(API, 테스트, 스크립트)가 거친다.
- **불변식(가장 중요)**: 검색 코퍼스에는 `sent` 전이 시점에만 답변이 추가된다(6-2의 개발자 시드 제외).
  `sent` 전이와 코퍼스 추가는 **같은 DB 트랜잭션**에서 수행한다. 임베딩 계산은 트랜잭션 전에 끝내 두고,
  임베딩에 실패하면 `sent`로 전이하지 않고 에러를 반환한다(발송됐는데 코퍼스에 없는 상태를 만들지 않는다).
  draft·approved·선택되지 않은 후보·`superseded` 후보는 어떤 경로로도 임베딩되지 않는다.
  추가되는 내용은 담당자가 수정한 최종본(`edited_answer ?? answer`)이다.
- 데이터 개념: 민원(`complaints`), 답변초안(`drafts`), 코퍼스(`corpus_entries`: source, content, origin, embedding, embedding_model).
  세부 컬럼은 자유.

## 4. 생성 파이프라인 (내부 구현은 자유. 레거시에서 아래만 가져온다)
**처리 순서** (아키텍처 ②~⑤)
1. 검색: 민원 원문으로 `search(query, top_k)` 호출.
2. 분석: `is_answerable`, `missing_info`, `request_summary`.
3. 근거 선별 + 접근 유형 1~3개 결정(`selected_sources`, `approaches`). 비어 있으면 `['PROCEDURE_GUIDE']`.
4. 접근 유형별 답변 작성 → 후보. 후보 1개 = 접근 유형 1개.
- 지연이 문제로 **측정되면** 2·3단계를 한 호출로 합칠 수 있도록 단계를 함수 단위로 분리해 둔다. 미리 합치지 않는다.

**가져올 것**
1. **접근 유형 프리셋 4개**와 라벨/설명(`prompts.py`의 `APPROACH_PRESETS`).
2. **프롬프트 문구**: `COMMON_RULES`, 단계별 시스템 프롬프트, 스키마 description을 가져오되 용어만 새 계약에 맞춘다:
   `selected_template_ids`/`selected_knowledge_ids` → `selected_sources`, `used_template_ids`/`used_knowledge_ids` → `used_sources`,
   `content` → `answer`, "템플릿·지식" → "근거(과거 승인 답변)".
   STAGE3의 "(assumptions는 최종 응답 계약 필드는 아니고, 검토자가 확인할 부가 정보다.)"는 새 계약과 맞지 않으므로
   "(assumptions는 검토자가 확인할 정보다.)"로 바꾼다. 스키마 description의 "이 목록을 비우려고 문장을 삭제하지 말 것."은 유지.
   레거시의 `[민원]`에 들어가던 제목은 쓰지 않는다(접수는 본문 하나만 받는다).
   **그 외 문구와 분량·형식 지시("5문장 이내" 등)는 바꾸지 않는다.** 분량·형식 지시를 시스템 프롬프트에서 빼고 description에만 두면
   답변 길이가 통제되지 않아 잘렸던 실측이 있다.
   프롬프트는 `apps/api/src/generation/prompts.ts` 한 파일에 모은다(실험 시 이 파일만 수정).
3. **근거 enum 제한**(`_id_field` 방식), **`assumptions`**(근거 없이 넣은 내용을 모델이 스스로 적는 필드).
4. **폴백**: `json_schema(strict)` 요청이 실패하면 `json_object` + 스키마를 system 메시지로 명시해 재요청.
   폴백 경로를 탔는지 로그에 남긴다(실제로 쓰이는지 확인용).
   - **응답 검증(필수)**: Ollama 클라우드는 `json_schema`를 받아도 스키마를 강제하지 않는다(실측: `gemma4:31b`는 일반 문장이나
     ```` ```json ```` 코드펜스로 감싼 JSON을 돌려주고, 필드를 빠뜨리거나 이름을 바꾸기도 한다). 그래서 응답이 200이어도 그대로 믿지 않는다.
     응답에서 코드펜스를 벗기고 JSON 객체를 추출한 뒤 **zod로 검증**(근거 enum 제한 포함)한다. 실패하면 1회 재시도 후 명확한 에러.
   - 모델별 추가 파라미터(예: `reasoning_effort`)는 `LLM_EXTRA_BODY`(JSON 문자열)로 받아 `extra_body`에 합친다.
5. **컨텍스트 포맷**: `[근거 — 과거 승인 답변]` 아래에 `- (source) content`.

**버릴 것**: `rag_search` 의존, 템플릿/지식 이중 구조, baseline 경로, 3b 전용 tier 분기, `IS_LOCAL` 문자열 매칭, 하드코딩된 `num_thread`.

**동작 요구**
- 후보는 병렬 생성하되 `LLM_CONCURRENCY` 한도를 지킨다. 후보 하나가 실패해도 나머지는 반환하고 실패는 봉투의 `failed`에 담는다.
- `finish_reason: length`로 JSON이 잘리면 1회 재시도 후 명확한 에러. JSON 파싱 실패도 같은 처리.
- `is_answerable == false`여도 생성은 계속하고 `is_info_sufficient=false`, `insufficient_reason`(= `missing_info`를 `"; "`로 연결)을 담는다.
- **진행 이벤트(필수)**: 생성이 수십 초 걸릴 수 있으므로 단계별 진행을 SSE로 제공한다(6번 `GET /complaints/:id/progress`).
  - 생성 요청(`generate`, `quick`)은 **즉시 `202 { complaint_id, run_id }`를 반환**하고 생성은 백그라운드에서 진행한다.
  - 진행 이벤트는 민원별로 **메모리에 버퍼링**한다. 구독하면 현재 실행(run)의 지난 이벤트부터 다시 보낸 뒤 이어서 보낸다
    (늦게 구독해도 놓치지 않는다). 버퍼는 완료 후 10분 뒤 삭제. 서버 재시작 시 사라져도 된다(시연용).
  - 마지막 이벤트 `done`에 `GenerateApiResponse` 전체를 담는다. 실패 시 `error` 이벤트로 끝난다.
  - 같은 민원에 생성이 진행 중이면 새 생성 요청은 `409`.
  - SSE 없이도 결과를 볼 수 있게 `GET /complaints/:id`는 최신 실행의 결과와 진행 상태(`running|done|error`)를 포함한다.
- 로그: 단계명, 소요 시간, 토큰 수, `finish_reason`만. 민원 원문·답변 본문은 남기지 않는다.

## 5. 검색부와 임베딩
- 인터페이스(DI 토큰) `SearchEngine.search(query, top_k)`. 구현체는 `SEARCH_ENGINE=mock|vector`로 선택.
  - `mock`: 고정 2건(`K-0001` 저녁 유예 19:00~22:00 운영 안내, `K-0002` 주민신고제 지역 24시간 단속). 레거시 mock과 같은 내용.
  - `vector`: `corpus_entries`를 대상으로 검색.
- **임베딩**: OpenAI 호환 `/embeddings` 호출, 모델은 `EMBEDDING_MODEL`(기본 `bge-m3`). 엔드포인트는 `EMBEDDING_BASE_URL`
  (기본 `http://localhost:11434/v1`. LLM과 **별도로** 설정한다. LLM을 외부로 돌려도 임베딩은 로컬에 남아야 한다).
- **벡터DB**: PostgreSQL + pgvector. `corpus_entries.embedding vector(N)` 컬럼(N은 임베딩 모델 차원, `bge-m3`는 1024)에 저장하고,
  코사인 거리 연산자(`<=>`)로 top_k(기본 `SEARCH_TOP_K=3`)를 검색한다. **HNSW 인덱스**(`vector_cosine_ops`)를 만든다.
  차원 N은 마이그레이션에 고정되므로 `EMBEDDING_DIM`과 실제 모델 출력 차원이 다르면 시작 시 에러로 중단한다.
- 벡터 SQL은 `CorpusRepository` 한 곳에만 둔다. 다른 코드는 `search()` 인터페이스만 사용한다(벡터DB 교체 대비).
- **하이브리드(옵션)**: `SEARCH_HYBRID=true`면 `pg_trgm` 유사도를 섞는다("저녁 유예", "주민신고제" 같은 핵심어가 임베딩에서 묻히는 경우 대비).
- 임베딩 호출이 불가하면 키워드 매칭으로 폴백하고 로그에 경고. 시그니처는 동일.
- **임베딩 모델 변경 대응**: 항목마다 `embedding_model`을 저장한다. 시작 시 현재 `EMBEDDING_MODEL`과 다른 항목이 있으면 경고하고,
  `POST /dev/corpus/reembed`로 전체 재임베딩할 수 있게 한다.
- `sent` 시점에 추가된 답변은 같은 코퍼스에 합류해 다음 검색에서 나온다(피드백 루프 ⑧).

## 6. API
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | /complaints | `{content}` 접수 → received |
| POST | /complaints/:id/generate | 검색 → 파이프라인 → 후보 저장, 상태 draft(재생성 시 draft 유지). **즉시 `202 { complaint_id, run_id }`**, 결과는 SSE `done` 또는 `GET /complaints/:id` |
| GET | /complaints/:id/progress | SSE. 지난 이벤트 재전송 후 이어서: 단계 시작/완료, 후보별 완료/실패, `done`(결과 포함) / `error` |
| GET | /complaints/:id | 민원 + 현재 후보 목록 + 상태 |
| PATCH | /drafts/:id | `selected`, `edited_answer` 수정(상태 draft에서만). 선택은 민원당 1개 |
| POST | /complaints/:id/approve | 선택된 후보 기준 approved |
| POST | /complaints/:id/send | sent 전이 + 코퍼스 추가. **외부 전송 없음**(시연) |
| POST | /complaints/quick | 접수 + 생성 시작을 한 번에(데스크톱 첫 화면용). 즉시 `202 { complaint_id, run_id }` |
| GET | /health | DB·LLM·임베딩 연결 상태와 **각 엔드포인트가 로컬인지**(호스트가 loopback/사설 IP인지) 표시 |
- 입력 검증(민원 본문 최대 길이 `COMPLAINT_MAX_CHARS`, 기본 5000), 에러 응답 형식 통일, Swagger 노출(`/docs`).
- LLM 장애·타임아웃 시 담당자가 이해할 수 있는 한국어 메시지를 반환한다.

### 6-2. 개발자용 시드 API (Excel 업로드)
시드 답변(사전 검수된 과거 승인 답변)을 코드 수정 없이 Excel로 넣고 바꾼다. 시연 준비용 **개발자 전용** 기능이다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | /dev/seed/template.xlsx | 빈 양식(헤더 + 예시 1행) 다운로드 |
| POST | /dev/seed/import | `.xlsx` 업로드(`multipart/form-data`, 필드명 `file`). 쿼리: `mode=append\|replace`(기본 append), `dryRun=true\|false`(기본 false) |
| GET | /dev/seed | 현재 코퍼스 목록(source, content 앞부분, origin, 등록 시각) |
| GET | /dev/seed/export.xlsx | 현재 시드를 같은 양식으로 내보내기 |
| DELETE | /dev/seed/:source | 시드 1건 삭제(`origin='seed'`만 가능) |
| POST | /dev/corpus/reembed | 전체 재임베딩(5번) |

- **양식**: 첫 시트, 1행은 헤더. 열은 `source`(선택), `content`(필수). 그 외 열은 무시한다.
  `source`가 비면 `S-0001` 형식으로 자동 부여. `content`는 최대 2,000자.
- **제한**: 파일 5MB, 2,000행. `.xlsx`가 아니면 거부.
- **검증**: 빈 `content`, 길이 초과, `source` 형식 오류 행은 건너뛰고 오류로 보고. 파일 안에서 `source`가 중복되면 해당 행들 오류.
  이미 있는 `source`는 append에서 **내용 갱신**(upsert) 후 재임베딩. 단, `origin='sent'` 항목과 겹치는 `source`는 오류.
- **응답**: `{ total, inserted, updated, skipped, errors: [{ row, reason }] }`. `dryRun=true`면 DB·코퍼스를 바꾸지 않고 같은 결과만 반환.
- **임베딩**: 변경된 행만 임베딩. 실패 행은 오류로 보고하고 부분 성공 허용.
- **출처 구분**: `origin: 'seed' | 'sent'`. `mode=replace`는 **`origin='seed'`만** 지우고 새로 넣는다. 발송으로 쌓인 항목은 건드리지 않는다.
- **불변식과의 관계**: 시드는 RDB 답변초안과 무관한 별도 입력이다. draft·approved·선택되지 않은 후보는 이 경로로도 코퍼스에 들어가지 않는다.
- **접근 제한**: `DEV_API_ENABLED=true`일 때만 라우트를 등록(기본 false). 활성화돼도 `X-Dev-Key` 헤더가 `DEV_API_KEY`와 일치해야 한다.
  담당자용 데스크톱은 이 API를 호출하지 않는다.
- 편의를 위해 CLI도 제공: `pnpm seed:import <파일.xlsx> [--replace] [--dry-run]` (같은 서비스 로직 재사용).

### 6-3. 모델 비교 — 범위 제외
- 모델 비교 기능(요청별 `model` 파라미터, `ALLOWED_MODELS`, `pnpm bench:models`, 비교 세트)은 **만들지 않는다**.
  소형 모델(3b·7b)의 한계는 레거시 Python 실험에서 이미 확인했다.
- 생성에 쓴 모델명은 drafts·generation_runs에 저장하고 `GenerateApiResponse.model`과 SSE 이벤트에 포함한다(계약 타입에는 넣지 않는다).

## 7. 환경변수 (`.env.example`)
| 이름 | 기본값 | 설명 |
|---|---|---|
| `OPENAI_BASE_URL` | `http://localhost:11434/v1` | LLM 엔드포인트(OpenAI 호환) |
| `OPENAI_API_KEY` | `ollama` | |
| `MODEL` | `qwen2.5:7b` | 생성 모델. 개발: 로컬 `qwen2.5:7b` / 시연: Ollama 클라우드 `gemma4:31b`(`OPENAI_BASE_URL=https://ollama.com/v1`, `OPENAI_API_KEY`=계정 키) |
| `LLM_MAX_TOKENS` | `512` | 레거시 250은 3b 기준. 잘림 발생 시 로그 확인 |
| `LLM_TEMPERATURE` | `0.3` | |
| `LLM_TIMEOUT_MS` | `120000` | |
| `LLM_CONCURRENCY` | `2` | CPU 전용 서버면 1 |
| `OLLAMA_OPTIONS` | (없음) | JSON 문자열. 예: `{"keep_alive":-1,"num_ctx":4096,"num_thread":4}`. 설정 시에만 `extra_body`로 전달 |
| `LLM_EXTRA_BODY` | (없음) | JSON 문자열. 모델별 추가 파라미터(예: `{"reasoning_effort":"low"}`). `extra_body`에 합친다 |
| `EMBEDDING_BASE_URL` | `http://localhost:11434/v1` | LLM과 별도. `OPENAI_BASE_URL`로 대체하지 않는다 |
| `EMBEDDING_MODEL` | `bge-m3` | 바꾸면 재임베딩 필요 |
| `EMBEDDING_DIM` | `1024` | 벡터 컬럼 차원. 모델 출력과 다르면 시작 실패 |
| `SEARCH_ENGINE` | `vector` | `mock` \| `vector` |
| `SEARCH_TOP_K` | `3` | |
| `SEARCH_HYBRID` | `false` | |
| `DATABASE_URL` | `postgresql://app:app@localhost:5432/minwon` | docker-compose 기본값과 일치 |
| `TEST_DATABASE_URL` | `postgresql://app:app@localhost:5433/minwon_test` | 테스트 전용 DB(docker-compose의 `db-test`) |
| `PORT` | `3000` | API 포트 |
| `CORS_ORIGINS` | `http://localhost:5173` | |
| `COMPLAINT_MAX_CHARS` | `5000` | |
| `REQUIRE_LOCAL` | `db,embedding` | 여기 적힌 구성요소가 로컬이 아니면 시작 중단. 운영 서버가 정해지면 `db,embedding,llm` |
| `DEV_API_ENABLED` | `false` | |
| `DEV_API_KEY` | (없음) | |

## 8. 테스트 (AI 수정 검증용, 반드시 포함)
- **계약 스냅샷**: `Candidate` / `GenerateResponse` / search 반환 형태가 바뀌면 실패.
- **프롬프트 스냅샷**: `prompts.ts`의 시스템 프롬프트·스키마가 바뀌면 실패(의도적 변경 시에만 스냅샷 갱신).
- **상태 전이**: 허용 전이만 통과, 불허 전이(draft→sent, sent→draft 등)는 예외.
- **불변식**: sent 전에는 코퍼스가 늘지 않고 sent 후에만 늘어난다. draft·approved·superseded 후보는 검색에 절대 나오지 않는다.
  임베딩 실패 시 상태가 sent로 바뀌지 않는다(트랜잭션).
- DB가 필요한 테스트는 docker-compose의 테스트용 Postgres(pgvector)로 실행한다. 벡터 검색 테스트는 임베딩을 고정 벡터로 mock한다.
- **enum 제한**: 검색 결과에 없는 source가 `used_sources`에 오면 스키마에서 거부.
- **부분 실패**: 후보 3개 중 1개 LLM 실패 시 2개 반환 + `failed` 1건.
- **시드 import**: 정상 파일, 빈 `content`, 중복 `source`, `sent`와 겹치는 `source`, 헤더 누락, 용량 초과, 잘못된 형식, `dryRun`(DB 불변),
  `replace`가 seed만 지우고 sent 보존, `DEV_API_ENABLED=false`일 때 404, 키 불일치 시 401.
- 파이프라인 통합 테스트(LLM·임베딩 mock) 1개.
- **스모크 스크립트** `pnpm smoke`: 실제 엔드포인트로 접수 → 생성 → 선택·수정 → 승인 → 발송 → 같은 민원 재검색 시 방금 답변이 근거로 나오는지까지 확인.
- **수동 확인(README에 체크리스트로 남길 것)**: 합성 민원 3건을 실제 모델로 돌려 답변 길이, 메타 발화("규칙에 따라~"),
  "유예 시간에 단속" 오답, 다른 언어 혼입 여부 확인.

## 9. 개인정보 / 운영 주의
- 시연은 로컬 전용이지만, 개발 중 외부 엔드포인트를 쓸 수 있으므로 **시연 데이터는 합성 데이터만** 사용한다.
- 민원 원문(이름, 연락처, 차량번호)과 답변 본문을 로그·에러 메시지에 남기지 않는다.
- DB 데이터 볼륨, `.env`, 업로드 임시 파일은 git에 올리지 않는다(`.gitignore`). 업로드 임시 파일은 처리 후 삭제.

## 10. 작업 순서와 완료 기준
1. 모노레포 뼈대, `packages/contracts`, 계약·상태 전이·불변식 테스트 → **먼저 계획을 보여주고 확인받은 뒤 시작.**
2. `mock` 검색 + 생성 파이프라인 + `/complaints` API + SSE.
3. 임베딩 + `vector` 검색 + 발송 시 코퍼스 추가.
4. 시드 Excel API + CLI.
5. 스모크 스크립트, README(실행 방법, 환경변수, 수동 확인 체크리스트).
- 각 단계가 끝날 때마다 테스트를 돌리고 결과를 보고한다.
- **완료 기준**: `pnpm test` 전부 통과, `pnpm smoke` 성공, README대로 새 환경에서 실행 가능.
- **로컬 증명 기준**
  - `REQUIRE_LOCAL`에 적힌 구성요소(기본 DB·임베딩)가 로컬이 아니면 시작 시 **에러로 중단**한다.
  - 인터넷을 끊은 상태에서도 시드 import, 임베딩, 벡터 검색, 발송 시 코퍼스 추가가 동작한다(`pnpm smoke --no-llm`: 생성 단계만 mock).
  - `pnpm smoke --local-llm qwen2.5:3b`: 개발 PC의 CPU로 작은 모델을 돌려 전 과정이 로컬에서 끝까지 도는지 확인(느려도 됨).
  - 런타임에 설정된 엔드포인트 외의 외부 네트워크 호출(CDN, 텔레메트리 등)이 없어야 한다. 필요한 모델은 사전에 `ollama pull`.

## 11. 하지 말 것
- 계약 필드, 함수 시그니처, 상태 전이 순서를 "정리" 명목으로 바꾸지 말 것.
- 4번에서 허용한 용어 치환 외에 프롬프트 문구를 임의로 "개선"하지 말 것.
- `reference/python/`을 수정하거나 Python 코드를 실행 경로에 넣지 말 것.
- 요구사항에 없는 인증, 큐, 캐시, 추가 단계를 만들지 말 것.
- pgvector 외의 벡터 저장소(메모리 계산, 별도 벡터DB 서버 등)로 임의 대체하지 말 것.

## 12. 미확정 (임의로 정하지 말고 환경변수/설정으로 열어 둘 것)
- 운영 서버 사양(GPU 유무, RAM)과 그에 맞는 모델. 시연은 Ollama 클라우드 `gemma4:31b`.
- 시드 답변의 실제 내용(합성). Excel 양식에 열 추가가 필요한지(예: 접근 유형 태그).