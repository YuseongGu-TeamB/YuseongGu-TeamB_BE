# 민원 답변 자동화 백엔드 (시연용)

안전신문고 민원을 넣으면 과거 승인 답변을 근거로 **답변 후보**를 만들고, 담당자가 선택·수정·승인·발송하면
그 답변이 다시 **검색 근거로 쌓이는** NestJS 백엔드입니다.

- 요구사항: [docs/backend-spec.md](docs/backend-spec.md) (유일한 기준)
- 구조와 원칙: [docs/architecture.md](docs/architecture.md) (①~⑧ 단계, 바꾸면 안 되는 것)

시연에서 보여주는 것
1. 민원 → 답변 후보 생성 → 발송한 답변이 다음 검색의 근거로 나온다(피드백 루프).
2. 임베딩·벡터DB·RDB·API는 GPU 없는 PC에서 **로컬로** 돈다(`REQUIRE_LOCAL`, `/health`).
3. 생성 LLM은 OpenAI 호환 엔드포인트라 **`.env`만 바꿔** 로컬 ollama ↔ Ollama 클라우드(`gemma4:31b`)를 오간다.

## 구조

```
apps/api            NestJS 백엔드
apps/desktop        담당자용 데스크톱(Electron + React, KRDS) — docs/frontend-spec.md
  prisma/           schema.prisma + 마이그레이션 (PostgreSQL + pgvector)
  src/generation/   생성 파이프라인, prompts.ts(프롬프트는 이 파일만 수정), LLM 호출
  src/search/       검색(SEARCH_ENGINE=mock|vector)
  src/corpus/       근거 코퍼스 — 벡터 SQL은 corpus.repository.ts 한 곳에만
  src/complaints/   민원·후보 API, 상태 전이(transition() 하나), 발송
  src/seed/         개발자용 시드 Excel API
  src/cli/          pnpm seed:import
  src/smoke/        pnpm smoke
packages/contracts  변경 금지 계약(zod 스키마 + 타입) — api·desktop이 함께 import
reference/python/   레거시 참고 코드(수정 금지, 실행 경로 아님)
```

## 준비물

| 항목 | 버전·비고 |
|---|---|
| Node.js | 22.12 이상 (LTS) |
| pnpm | 10.34.6 — `corepack enable` 후 저장소에서 자동 사용 |
| Docker | PostgreSQL + pgvector 컨테이너용 (없이 설치하는 방법은 아래) |
| ollama | 임베딩 `bge-m3` 필수. 로컬 생성 시 `qwen2.5:7b`(개발), `qwen2.5:3b`(로컬 스모크) |

```bash
ollama pull bge-m3
ollama pull qwen2.5:7b      # 로컬로 생성할 때
ollama pull qwen2.5:3b      # pnpm smoke --local-llm qwen2.5:3b 할 때
```

> Windows에서 `corepack enable`이 `C:\Program Files\nodejs`에 쓸 권한이 없다는 EPERM으로 실패하면
> `corepack enable --install-directory "$(npm config get prefix)"` 후
> `corepack prepare pnpm@10.34.6 --activate`. (Node 22에 들어 있는 corepack은 pnpm 12를 실행하지 못한다)

## 빠른 시작

```bash
pnpm install                 # contracts 빌드·Prisma 클라이언트 생성까지 자동
cp .env.example .env         # 기본값은 전부 로컬
pnpm db:up                   # PostgreSQL + pgvector (localhost:5432)
pnpm db:migrate
pnpm seed:import <시드.xlsx> # 근거 코퍼스 넣기 (양식은 아래 "시드")
pnpm dev                     # http://localhost:3000
```

- API 문서(Swagger): http://localhost:3000/docs
- 상태 확인: `GET /health` — DB·LLM·임베딩 연결 여부와 **각 엔드포인트가 로컬(loopback/사설 IP)인지**
- 운영처럼 실행: `pnpm build && pnpm start`

### 시연 모델로 전환 (Ollama 클라우드 `gemma4:31b`)

`.env`에서 LLM 세 줄만 바꿉니다. 임베딩(`EMBEDDING_BASE_URL`)은 로컬 그대로 둡니다.

```dotenv
OPENAI_BASE_URL=https://ollama.com/v1
OPENAI_API_KEY=<Ollama 계정 API 키>   # .env에만. 커밋 금지
MODEL=gemma4:31b
```

Ollama 클라우드는 `json_schema`를 받아도 스키마를 강제하지 않습니다. 서버는 응답을 zod로 검증하고, 스키마를 따르지 않는
모델은 자동으로 `json_object` + 스키마 명시(폴백) 방식으로 바꿔 요청합니다. 로그에 `→ 이후 json_object 폴백 사용`이 한 번 찍히면 정상입니다.

## 데스크톱 (apps/desktop)

담당자 화면: **민원 붙여넣기 → 답변 후보 → 선택·수정 → 승인·전송 → 새 민원**. 요구사항은 [docs/frontend-spec.md](docs/frontend-spec.md).

```bash
pnpm dev            # 1) 백엔드 (http://localhost:3000)
pnpm desktop:dev    # 2) 데스크톱 창 (렌더러 http://localhost:5173)
```

- API 주소는 `apps/desktop/.env`의 `VITE_API_BASE_URL`(기본 `http://localhost:3000`, 예시는 `apps/desktop/.env.example`).
- 백엔드 `CORS_ORIGINS`에 `http://localhost:5173`이 있어야 합니다(기본값). 시연은 dev 모드로 하고, 빌드한 앱(`file://`)은 범위 밖입니다.
- 헤더 오른쪽 배지: DB·임베딩·LLM이 **로컬/외부**인지와 연결 상태(`/health`, 30초마다 갱신).
- 디자인은 KRDS(`krds-uiux`)의 `resources/css/component/output.css`와 로컬 PretendardGOV 글꼴만 씁니다. 외부 CDN·웹폰트 호출이 없습니다.
- `pnpm desktop:dev`는 VSCode 등에서 물려받은 `ELECTRON_RUN_AS_NODE`를 지우고 실행합니다(이 값이 있으면 창이 뜨지 않음).

**시연 순서(피드백 루프 확인)**: 민원을 넣고 후보 하나를 골라 수정·전송 → "새 민원 입력"으로 **같은 내용**을 다시 넣으면, 후보의 근거에 방금 전송한 답변(`A-…`)이 보입니다.

## 환경변수

전체 목록·기본값·설명은 [.env.example](.env.example)에 있습니다. 자주 바꾸는 것만:

| 이름 | 기본값 | 설명 |
|---|---|---|
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `MODEL` | 로컬 ollama / `ollama` / `qwen2.5:7b` | 생성 LLM |
| `LLM_EXTRA_BODY` | (없음) | 모델별 추가 파라미터 JSON. 예: `{"reasoning_effort":"low"}` |
| `OLLAMA_OPTIONS` | (없음) | ollama 옵션 JSON. 예: `{"keep_alive":-1,"num_ctx":4096,"num_thread":4}` |
| `LLM_CONCURRENCY` | `2` | 후보 병렬 생성 수. CPU 전용 서버면 1 |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` | 로컬 ollama / `bge-m3` / `1024` | LLM과 **별도**. 차원이 DB·모델과 다르면 시작 실패 |
| `SEARCH_ENGINE` | `vector` | `mock`이면 레거시 고정 2건 |
| `SEARCH_HYBRID` | `false` | `true`면 pg_trgm 유사도를 섞음(벡터 0.7 : trigram 0.3) |
| `REQUIRE_LOCAL` | `db,embedding` | 여기 적힌 구성요소가 로컬이 아니면 **시작 중단**. 운영 서버가 정해지면 `db,embedding,llm` |
| `DEV_API_ENABLED` / `DEV_API_KEY` | `false` / (없음) | 개발자 시드 API. 켜면 키 필수 |

## API 흐름

| 단계 | 요청 |
|---|---|
| ① 접수 | `POST /complaints {content}` → `received` |
| ②~⑤ 생성 | `POST /complaints/:id/generate` → 즉시 `202 {complaint_id, run_id}`, 백그라운드 생성 → `draft` |
| 진행 | `GET /complaints/:id/progress` (SSE). 늦게 구독해도 지난 이벤트부터 재전송. 마지막은 `done`(결과 전체) 또는 `error` |
| 조회 | `GET /complaints/:id` — 현재 후보, 상태, 최신 생성(`running|done|error`)과 결과 |
| ⑥ 검토 | `PATCH /drafts/:id {selected, edited_answer}` — `draft` 상태에서만, 선택은 민원당 1개 |
| ⑦ 승인 | `POST /complaints/:id/approve` → `approved` |
| ⑦⑧ 발송 | `POST /complaints/:id/send` → `sent` + 근거 코퍼스 추가(외부 전송 없음) |
| 한 번에 | `POST /complaints/quick {content}` → 접수 + 생성 시작, `202` |

- SSE 이벤트: `run_started`, `stage_started`/`stage_completed`(search·analyze·select·write:접근유형), `candidate_completed`/`candidate_failed`, `done`/`error`. 모든 이벤트에 `run_id`, `model`.
- 생성 중 같은 민원에 다시 생성하면 `409`. 에러 응답은 항상 `{statusCode, error, message}`(한국어 메시지).

**핵심 불변식**: 근거 코퍼스에는 `sent` 전이 시점에만, 담당자 최종본(`edited_answer ?? answer`)만 들어갑니다.
임베딩을 먼저 계산하고, `sent` 전이와 코퍼스 추가는 한 트랜잭션입니다. 임베딩이 실패하면 발송되지 않습니다(`503`, 상태 `approved` 유지).

## 시드 (개발자 전용 Excel)

`.env`에 `DEV_API_ENABLED=true`, `DEV_API_KEY=<임의 문자열>`을 두면 `/dev` 라우트가 열립니다. 모든 요청에 `X-Dev-Key` 헤더가 필요합니다.

| 요청 | 설명 |
|---|---|
| `GET /dev/seed/template.xlsx` | 빈 양식(헤더 + 예시 1행) |
| `POST /dev/seed/import?mode=append\|replace&dryRun=true\|false` | `.xlsx` 업로드(필드명 `file`) |
| `GET /dev/seed` · `GET /dev/seed/export.xlsx` | 목록 · 시드 내보내기 |
| `DELETE /dev/seed/:source` | 시드 1건 삭제(`origin=seed`만) |
| `POST /dev/corpus/reembed` | 임베딩 모델을 바꾼 뒤 전체 재임베딩 |

- 양식: 첫 시트, 1행 헤더 `source`(선택) · `content`(필수, 2,000자 이하). 파일 5MB·2,000행 이하.
- `source`가 비면 `S-0001`부터 자동 부여. 같은 `source`는 append에서 내용 갱신. 발송 답변(`A-…`)과 겹치면 오류.
- 응답 `{ total, inserted, updated, skipped, errors: [{row, reason}] }` — `row`는 엑셀 행 번호, `skipped`는 오류 행 + 내용이 같아 바꿀 것 없는 행.
- `replace`는 시드만 지우고 다시 넣습니다. 발송으로 쌓인 항목은 그대로입니다.

CLI (같은 로직, `DEV_API_ENABLED`와 무관):

```bash
pnpm seed:import ./seed.xlsx              # append
pnpm seed:import ./seed.xlsx --dry-run    # DB 변경 없이 결과만
pnpm seed:import ./seed.xlsx --replace
```

## 테스트

```bash
pnpm db:test:up    # 테스트 전용 DB (localhost:5433, tmpfs)
pnpm test          # 계약·프롬프트 스냅샷, 상태 전이, 불변식, 파이프라인, API, 검색, 시드
```

- 계약(`packages/contracts`)이나 `prompts.ts`를 바꾸면 스냅샷 테스트가 실패합니다. **의도한 변경일 때만** `pnpm --filter <패키지> exec jest -u`로 갱신하세요.
- LLM·임베딩은 테스트에서 가짜로 대체합니다. 실제 엔드포인트 확인은 스모크로 합니다.

## 스모크

시드 import → 접수 → 생성(SSE) → 선택·수정 → 승인 → 발송 → **같은 민원 재검색 시 방금 답변이 근거로 나오는지**까지 실제로 돌립니다.
시연 코퍼스를 오염시키지 않도록 **테스트 DB(`db-test`)를 비우고** 씁니다(`pnpm db:test:up` 필요).

```bash
pnpm smoke                          # .env의 LLM으로 (예: gemma4:31b)
pnpm smoke --no-llm                 # 생성 단계만 결정적 응답. 인터넷 없이 시드·임베딩·벡터 검색·코퍼스 추가 확인
pnpm smoke --local-llm qwen2.5:3b   # LLM까지 로컬 CPU로 끝까지(느림)
```

## 수동 확인 체크리스트 (실제 모델)

모델·프롬프트를 바꾼 뒤 아래 합성 민원 3건을 `POST /complaints/quick`으로 넣고 후보를 눈으로 확인합니다.

1. `지족로364번길에 불법주정차가 너무 심합니다. 단속 강화해주세요.`
2. `저녁 8시에 가게 앞에 주차했는데 단속 문자를 받았습니다. 유예 시간 아닌가요? 정말 화가 납니다.`
3. `우리 아파트 앞 도로에 주차된 차 때문에 아이들이 위험해요. 어떻게 신고하면 되나요?`

- [ ] 답변이 5문장 이내이고 중간에 잘리지 않았다(로그 `finish_reason=stop`)
- [ ] "규칙에 따라", "지시에 따라", "참고자료에 따르면" 같은 **메타 발화**가 없다
- [ ] **유예 시간(19:00~22:00)에 단속한다**고 쓰지 않았다
- [ ] 한자·영문 문장 등 **다른 언어가 섞이지** 않았다
- [ ] `used_sources`가 비었는데 근거 없는 구체 정보(기간·부서·연락처)를 단정하지 않았다(`assumptions` 확인)

규칙 위반이 보이면 코드보다 모델 한계를 먼저 의심하고, 같은 입력으로 2~3번 다시 돌려 재현율부터 확인하세요([architecture 5번](docs/architecture.md)).

## Docker 없이 PostgreSQL + pgvector

운영 서버 OS는 미정이며 Linux를 기본으로 가정합니다.

**Ubuntu/Debian**
```bash
sudo apt install postgresql-16 postgresql-16-pgvector    # pg_trgm은 기본 포함(contrib)
sudo -u postgres psql -c "CREATE USER app WITH PASSWORD 'app';"
sudo -u postgres psql -c "CREATE DATABASE minwon OWNER app;"
sudo -u postgres psql -d minwon -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;"
pnpm db:migrate
```
(확장 생성은 마이그레이션에도 있지만, `app` 사용자가 슈퍼유저가 아니면 위처럼 미리 만들어 둡니다.)

**Windows**: PostgreSQL 공식 설치 파일로 설치한 뒤 pgvector는 [pgvector 저장소의 Windows 빌드 안내](https://github.com/pgvector/pgvector#windows)(Visual Studio `nmake`)를 따릅니다. 번거로우면 Docker Desktop 또는 WSL2의 Ubuntu 방식을 권장합니다.

## 운영·개발 메모

- **로그**에는 단계명·소요 시간·토큰 수·`finish_reason`·폴백 여부만 남습니다. 민원 원문·답변 본문은 남기지 않습니다.
- **시연 데이터는 합성 데이터만** 씁니다(외부 LLM 엔드포인트로 원문이 나갈 수 있음).
- `.env`, DB 볼륨, 업로드 파일은 커밋하지 않습니다. 시드 업로드는 메모리에서만 처리합니다(임시 파일 없음).
- **마이그레이션 주의**: HNSW·trigram 인덱스와 일부 CHECK 제약은 `schema.prisma`로 표현할 수 없어 SQL로 직접 넣었습니다.
  `prisma migrate dev`가 이 인덱스를 `DROP`하는 SQL을 만들면 그 줄은 지우고 적용하세요.
- Prisma CLI의 사용 통계 전송을 끄려면 `CHECKPOINT_DISABLE=1`. 서버 실행 중에는 설정된 엔드포인트 외 외부 호출이 없습니다(Swagger UI도 로컬 파일).
- Windows Git Bash의 `curl -d '{"content":"한글"}'`은 한글이 깨져 전송될 수 있습니다. Swagger(`/docs`)나 파일(`-d @body.json`)을 쓰세요.

## 문제 해결

| 증상 | 확인 순서 |
|---|---|
| 생성이 `JSON 파싱 실패`·`스키마 불일치`로 끝남 | 로그의 `finish_reason=length`(→ `LLM_MAX_TOKENS`) → 폴백 전환 로그 → 모델이 OpenAI 호환을 지키는지 |
| 서버가 `REQUIRE_LOCAL`로 시작 안 함 | 메시지에 나온 구성요소의 엔드포인트가 로컬인지. LLM만 외부면 기본값(`db,embedding`)으로 충분 |
| 서버가 `EMBEDDING_DIM`으로 시작 안 함 | 임베딩 모델을 바꿨다면 컬럼 차원 마이그레이션 + `POST /dev/corpus/reembed` |
| 검색이 키워드 폴백만 함(경고 로그) | ollama 실행, `ollama list`에 `bge-m3`, `EMBEDDING_BASE_URL` |
| 로컬 ollama가 매번 느림 | `OLLAMA_OPTIONS`의 `keep_alive`, `num_thread`가 서버 코어 수에 맞는지 |
| 검색 근거가 이상함 | `GET /dev/seed`로 코퍼스 확인 — `origin`은 `seed`/`sent`만 있어야 정상 |
