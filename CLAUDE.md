# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 필수 환경 변수

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

모든 예제는 이 변수가 없으면 즉시 종료한다.

---

## 예제 실행 명령

### Python

```bash
pip install claude-agent-sdk fastapi uvicorn watchfiles

python just-chat/chat.py
python keep-history/history.py
python using-tools/tools.py
python with-mcp/mcp.py
python with-streaming/streaming.py
python with-workflow/workflow.py          # 전체 에이전트 루프, 약 2~5분 소요

# application-built-in (서버형 — Ctrl+C로 종료)
python application-built-in/chat_app.py       # http://localhost:8000
python application-built-in/saas_app.py       # http://localhost:8001
python application-built-in/automation_app.py # inbox/ 감시 후 자동 종료
```

### TypeScript (Bun)

```bash
bun add @anthropic-ai/claude-agent-sdk

bun run just-chat/chat.ts
bun run keep-history/history.ts
bun run using-tools/tools.ts
bun run with-mcp/mcp.ts
bun run with-streaming/streaming.ts
bun run with-workflow/workflow.ts

bun run application-built-in/chat_app.ts
bun run application-built-in/saas_app.ts
bun run application-built-in/automation_app.ts
```

### with-mcp 사전 조건

stdio transport 예제는 Node.js가 설치되어 있어야 한다(`npx`로 MCP 서버를 자동 설치).

---

## 코드 작성 규칙

### Python

- `sys.path.insert(0, str(Path(__file__).parent.parent))`로 `utils/` 경로를 추가한 뒤 `from utils.utils import ...`로 공통 함수를 import한다.
- 모든 예제 함수는 `async def`이며 진입점은 `asyncio.run(main())`이다.
- 메시지 처리 순서: `SystemMessage(init)` → `AssistantMessage` / `StreamEvent` → `ResultMessage` (마지막).

### TypeScript

- import는 `from "../utils/utils.ts"` 상대경로로 `.ts` 확장자를 명시한다.
- `message`는 `Record<string, unknown>`으로 받아 `msg.type`으로 분기한다.
- 런타임은 **Bun 전용**. `node` / `npm` / `npx` 대신 `bun` / `bun run` / `bunx`를 사용한다.

### 공통

- `utils/utils.py`와 `utils/utils.ts`에 공유 함수(`print_message`, `print_result`, `extract_session_id`, `format_cost`)가 있다. 새 예제를 작성할 때 중복 구현하지 말고 import해서 사용한다.
- 모든 예제의 마지막 출력은 `[done: success | turns: N | cost: $X.XXXX | session: ...]` 형식이다.
- 비용·무한루프 방어를 위해 `max_turns`와 `max_budget_usd`를 설정한다.
- 파일을 수정하는 예제는 임시 파일(`tempfile`)을 사용하거나 `with-workflow/reports/` 등 전용 디렉토리에만 쓴다.

---

## 코드베이스 아키텍처

### 폴더 구조 원칙

각 예제 폴더는 **독립적인 학습 단위**다. 다른 예제 폴더를 import하지 않는다. 유일한 공유 의존성은 `utils/`이다.

```
utils/          ← 모든 예제가 공유하는 출력·세션 유틸리티
just-chat/      ← query() + 메시지 타입 처리 (SDK 진입점)
keep-history/   ← ClaudeSDKClient / resume / list_sessions
using-tools/    ← allowed_tools / permission_mode / PostToolUse 훅
with-mcp/       ← mcp_servers (stdio · HTTP transport)
with-streaming/ ← include_partial_messages / StreamEvent
with-workflow/  ← 5단계 에이전트 루프 (GATHER→PLAN→EXECUTE→VERIFY→REPORT)
application-built-in/ ← 실제 앱에 SDK를 심는 4가지 통합 패턴
```

### with-workflow 실행 흐름

가장 복잡한 예제. `workflow.py`와 `workflow.ts`는 동일한 5단계를 구현한다:

1. **GATHER** — `Read`·`Glob`·`Grep`으로 프로젝트 탐색 → `session_id` 캡처
2. **PLAN** — `output_format`(JSON Schema) + `resume=session_id`로 구조화 계획 생성 → `ResultMessage.structured_output` 에서 dict로 바로 사용
3. **EXECUTE** — `depends_on`이 없는 단계는 `asyncio.gather`/`Promise.all`로 병렬 실행, 의존 단계는 순차
4. **VERIFY** — **원래 세션과 독립된 새 세션**으로 Critic 에이전트를 실행해 결과 검토 → 피드백 반영 후 최대 `max_iterations`회 반복
5. **REPORT** — `output_format` JSON + 마크다운 파일을 `with-workflow/reports/`에 저장

### application-built-in 통합 패턴

README에 4가지 통합 방법이 문서화되어 있다. 이 폴더의 코드는 전부 **A. 인프로세스** 방식이다:

- `chat_app.*` — FastAPI/Hono 서버, `resume=` + SSE 스트리밍으로 사용자별 세션 유지. `SESSIONS: dict[str, str]`는 인메모리이며 프로덕션에선 Redis 교체 필요.
- `saas_app.*` — API 키 인증, 테넌트별 쿼터 관리, `output_format` JSON 응답. `TENANTS` dict가 테넌트 설정과 사용량을 관리.
- `automation_app.*` — `watchfiles`/`fs.watch`로 `inbox/` 폴더를 감시하고 새 `.txt` 파일마다 에이전트를 실행해 결과를 `processed/`에 저장.

### 생성 산출물 (gitignore 대상)

| 경로 | 생성 주체 |
|------|-----------|
| `using-tools/audit.log` | `tools.py`·`tools.ts`의 PostToolUse 훅 |
| `with-workflow/reports/` | `workflow.py`·`workflow.ts` |
| `with-workflow/workflow_audit.log` | 동일 |
| `application-built-in/workspace/` | `automation_app.*` |
| `.agent_memory.json` | 워크플로우 장기 메모리 (선택) |

### 참고 문서

- `jargon.md` — SDK 전반 용어 사전 (개념·비유·대체제, 13개 카테고리)
- `ReadMe.md` — 설치·실행·메시지 타입·옵션 레퍼런스
- 각 폴더의 `README.md` — 해당 주제 심화 설명
