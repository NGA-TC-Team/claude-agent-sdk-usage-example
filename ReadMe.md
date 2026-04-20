# Claude Agent SDK — 사용 예제 모음

Claude Agent SDK의 핵심 기능을 주제별로 나눈 실습 예제 저장소다.
각 폴더는 독립적인 학습 단위로, 개념 설명(README.md) + Python 예제 + TypeScript 예제로 구성된다.

---

## Claude Agent SDK란?

Claude Agent SDK는 Claude Code를 **라이브러리**로 사용해 자율 에이전트를 구축하는 도구다.
파일 읽기, 명령 실행, 코드 편집, 웹 검색 등 빌트인 도구를 포함하며,
에이전트 루프(ReAct 패턴)를 SDK가 자동으로 처리한다.

```
개발자가 할 일: prompt 전달 → 메시지 수신
SDK가 할 일: 도구 선택 → 실행 → 결과 해석 → 반복 → 최종 응답
```

### Anthropic Client SDK와의 차이

| 항목 | Agent SDK | Anthropic Client SDK |
|------|-----------|----------------------|
| 도구 실행 | SDK가 자동 처리 (에이전트 루프) | 직접 구현 필요 |
| 파일 읽기/쓰기 | Read, Write, Edit 빌트인 | 없음 |
| 웹 검색 | WebSearch, WebFetch 빌트인 | 없음 |
| 터미널 실행 | Bash 빌트인 | 없음 |
| 세션/히스토리 | 디스크 자동 저장 | 직접 구현 필요 |
| 사용 목적 | 자율 에이전트, 자동화 파이프라인 | API 직접 호출, 세밀한 제어 |

---

## 설치 및 환경 설정

### 필수 조건

- **Python** 3.10 이상 또는 **Node.js** 18 이상 (Bun 권장)
- `ANTHROPIC_API_KEY` 환경 변수

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Python

```bash
pip install claude-agent-sdk
```

### TypeScript (Bun)

```bash
bun add @anthropic-ai/claude-agent-sdk
```

> TypeScript SDK는 Claude Code 바이너리를 optional dependency로 번들링한다.
> 별도로 Claude Code CLI를 설치하지 않아도 된다.

---

## 프로젝트 구조

```
claude-agent-sdk-usage-example/
├── just-chat/          # 기본 채팅 — SDK 진입점
│   ├── README.md
│   ├── chat.py
│   └── chat.ts
│
├── keep-history/       # 대화 히스토리 — 세션 관리
│   ├── README.md
│   ├── history.py
│   └── history.ts
│
├── using-tools/        # 도구 활용 — 파일/코드/터미널 조작
│   ├── README.md
│   ├── tools.py
│   └── tools.ts
│
├── with-mcp/           # MCP 서버 — 외부 시스템 연결
│   ├── README.md
│   ├── mcp.py
│   └── mcp.ts
│
├── with-streaming/     # 스트리밍 — 실시간 텍스트 출력
│   ├── README.md
│   ├── streaming.py
│   └── streaming.ts
│
├── with-workflow/      # 워크플로우 — 자율 에이전트 전체 사이클
│   ├── README.md
│   ├── workflow.py
│   └── workflow.ts
│
└── utils/              # 공통 유틸리티 (README 없음, 코드 내 주석)
    ├── utils.py
    └── utils.ts
```

---

## 폴더별 학습 목표

### `just-chat/` — SDK 진입점

`query()` 함수 하나로 Claude와 대화하는 가장 기본적인 패턴.

- `query()` 비동기 제너레이터 사용법
- `system_prompt`로 Claude 역할 지정
- `AssistantMessage`, `ResultMessage` 등 메시지 타입 구조
- `TextBlock`, `ToolUseBlock` 등 content 블록 분기 처리

### `keep-history/` — 세션 기반 멀티-턴 대화

Claude가 이전 대화를 기억하게 만드는 세 가지 방법.

- `ClaudeSDKClient` (Python) / `continue: true` (TypeScript) — 자동 세션 유지
- `ResultMessage.session_id` 캡처 후 `resume=` 으로 특정 세션 재개
- `list_sessions()`, `rename_session()`, `tag_session()` 세션 관리 API
- Redis · PostgreSQL · SQLite 등 외부 DB와 연동하는 패턴 (README 참고)

### `using-tools/` — 도구로 실제 작업 수행

Claude가 파일을 읽고, 코드를 수정하고, 명령을 실행하게 만드는 방법.

- `allowed_tools`로 최소 권한 원칙 적용 (읽기 전용 에이전트)
- `permission_mode="acceptEdits"`로 파일 편집 자동 승인
- `PostToolUse` 훅으로 모든 도구 실행을 감사 로그에 기록
- 빌트인 도구 전체 목록: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `AskUserQuestion`, `Monitor`

### `with-mcp/` — 외부 시스템 연결

MCP(Model Context Protocol)로 데이터베이스, API, 브라우저 등 외부 서비스를 Claude에 연결.

- stdio transport (로컬 프로세스): `@modelcontextprotocol/server-filesystem`
- HTTP transport (원격 서버): Claude Code 공식 문서 MCP
- 도구명 컨벤션: `mcp__<서버명>__<도구명>`
- `allowed_tools` 와일드카드로 서버 전체 도구 허용
- `SystemMessage(init)`에서 서버 연결 상태 확인 및 오류 처리

### `with-streaming/` — 실시간 텍스트 출력

응답이 완성되기 전에 텍스트를 즉시 화면에 표시하는 방법.

- `include_partial_messages=True` 옵션으로 `StreamEvent` 활성화
- `StreamEvent.event["delta"]["text"]`에서 텍스트 청크 추출
- 블로킹 방식 vs 스트리밍 방식의 TTFB(첫 출력 시간) 실측 비교
- 스트리밍을 쓰지 않을 때 발생하는 UX 문제와 타임아웃 위험

### `with-workflow/` — 자율 에이전트 워크플로우

실제 제품 수준의 에이전트가 어떻게 동작하는지 전체 사이클 구현.

```
GATHER → PLAN → EXECUTE → VERIFY → REPORT
```

- **GATHER**: `Glob`·`Grep`·`Read`로 프로젝트 지식 수집, session_id 캡처
- **PLAN**: `output_format` JSON 스키마로 단계별 계획 강제 생성 (structured output)
- **EXECUTE**: 의존성 없는 단계 `asyncio.gather` 병렬 실행, 의존 단계 순차 실행
- **VERIFY**: 독립 Critic 에이전트(별도 세션) 검토 + 피드백 반영 반복 개선
- **REPORT**: structured_output JSON + 마크다운 파일 저장

README에 지식 보관 수단(벡터DB·그래프DB·RAG), 계획 전략(ReAct·Plan-and-Execute·ToT), 실행 전략(병렬·Map-Reduce·파이프라인), 점검 전략(Critic·반복 루프), 보고 전략(MCP·Webhook·파일) 상세 설명 포함.

---

## 권장 학습 순서

```
just-chat → keep-history → using-tools → with-streaming → with-mcp → with-workflow
```

각 예제는 앞 예제의 개념을 전제로 하지 않아 독립 실행 가능하지만,
위 순서로 학습하면 SDK 전체 그림을 자연스럽게 익힐 수 있다.

---

## 각 예제 실행

```bash
# 1. just-chat
python just-chat/chat.py
bun run just-chat/chat.ts

# 2. keep-history
python keep-history/history.py
bun run keep-history/history.ts

# 3. using-tools
python using-tools/tools.py
bun run using-tools/tools.ts

# 4. with-mcp  (Node.js 필요 — stdio 서버 자동 설치)
python with-mcp/mcp.py
bun run with-mcp/mcp.ts

# 5. with-streaming
python with-streaming/streaming.py
bun run with-streaming/streaming.ts

# 6. with-workflow  (전체 실행 약 2~5분 소요)
python with-workflow/workflow.py
bun run with-workflow/workflow.ts
```

정상 실행 시 각 예제 마지막에 다음과 같은 라인이 출력된다:

```
[done: success | turns: N | cost: $X.XXXX | session: xxxxxxxxxxxxxxxx...]
```

---

## 핵심 메시지 타입

| 타입 | 언제 오는가 | 주요 필드 |
|------|------------|-----------|
| `SystemMessage` | 세션 시작 시 | `subtype="init"`, `session_id`, `mcp_servers` |
| `AssistantMessage` | Claude가 응답할 때마다 | `content[]` (TextBlock·ToolUseBlock 등) |
| `StreamEvent` | 스트리밍 활성화 시 텍스트 생성 중 | `event["delta"]["text"]` |
| `ResultMessage` | 에이전트 루프 완료 시 (마지막) | `result`, `session_id`, `total_cost_usd`, `subtype` |

`ResultMessage.subtype` 값:

| 값 | 의미 |
|----|------|
| `success` | 정상 완료 |
| `error_during_execution` | 실행 중 오류 |
| `error_max_turns` | 최대 턴 수 초과 |
| `error_max_budget_usd` | 비용 한도 초과 |

---

## 주요 옵션 요약

| 옵션 (Python) | 옵션 (TypeScript) | 설명 |
|---------------|-------------------|------|
| `allowed_tools` | `allowedTools` | 자동 승인할 도구 목록 |
| `system_prompt` | `systemPrompt` | Claude 역할·지침 설정 |
| `permission_mode` | `permissionMode` | 도구 실행 승인 방식 |
| `resume` | `resume` | 특정 session_id로 대화 재개 |
| `continue_conversation` | `continue` | 직전 세션 자동 이어받기 |
| `output_format` | `outputFormat` | JSON 스키마 강제 출력 |
| `include_partial_messages` | `includePartialMessages` | StreamEvent 활성화 |
| `mcp_servers` | `mcpServers` | MCP 서버 설정 |
| `hooks` | `hooks` | 도구 실행 전후 콜백 |
| `max_turns` | `maxTurns` | 에이전트 루프 최대 턴 |
| `max_budget_usd` | `maxBudgetUsd` | 단계별 비용 상한 |
| `cwd` | `cwd` | 에이전트 작업 디렉토리 |

---

## 참고 자료

- [용어 사전 (jargon.md)](./jargon.md) — SDK 전반의 용어 개념·비유·대체제 정리
- [Agent SDK 개요](https://code.claude.com/docs/en/agent-sdk/overview)
- [Python SDK 레퍼런스](https://code.claude.com/docs/en/agent-sdk/python)
- [TypeScript SDK 레퍼런스](https://code.claude.com/docs/en/agent-sdk/typescript)
- [세션 관리](https://code.claude.com/docs/en/agent-sdk/sessions)
- [MCP 연동](https://code.claude.com/docs/en/agent-sdk/mcp)
- [훅(Hooks)](https://code.claude.com/docs/en/agent-sdk/hooks)
- [MCP 서버 디렉토리](https://github.com/modelcontextprotocol/servers)
- [예제 에이전트 모음](https://github.com/anthropics/claude-agent-sdk-demos)
