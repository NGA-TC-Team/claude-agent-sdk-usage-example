# with-workflow — AI 에이전트 워크플로우

AI 에이전트가 자율적으로 작업을 수행하는 전체 사이클을 다룬다.

```
지식 수집 → 계획 수립 → 실행 → 결과 점검 → 보고/공유
```

이 패턴은 단순 질의응답을 넘어 **복잡한 작업을 자율적으로 완료하는 에이전트**를
설계할 때 필요한 핵심 구조다.

---

## 1. 지식 보관 수단

에이전트가 작업하기 전에 참고할 지식을 어디에, 어떻게 보관하느냐에 따라
에이전트의 능력 범위가 결정된다.

### 1-1. 파일 시스템 (가장 단순)

Claude Agent SDK가 기본으로 지원한다. `CLAUDE.md`, `.md` 파일, 코드 파일 등을
`Read`, `Glob`, `Grep` 도구로 직접 접근한다.

```
프로젝트/
├── CLAUDE.md          ← 프로젝트 전체 지침 (SDK가 자동 로드)
├── .claude/
│   └── CLAUDE.md      ← 추가 컨텍스트
└── docs/
    └── architecture.md
```

**장점**: 설정 없음, 버전 관리 가능  
**단점**: 대용량 문서에서 검색 느림, 시맨틱 검색 불가

### 1-2. 벡터 데이터베이스 (RAG)

문서를 임베딩 벡터로 변환해 저장하고, 쿼리와 의미적으로 유사한 문서를 검색한다.
에이전트 프롬프트에 검색 결과를 삽입해 컨텍스트로 활용한다.

**대표 솔루션**:

| 솔루션 | 특징 | 사용 방법 |
|--------|------|-----------|
| **Chroma** | 로컬, 경량, Python | `chromadb` 패키지 |
| **Pinecone** | 클라우드, 고성능 | REST API |
| **pgvector** | PostgreSQL 확장 | SQL + 벡터 연산 |
| **Qdrant** | 오픈소스, 필터 강력 | REST / gRPC |
| **Weaviate** | 그래프+벡터 하이브리드 | REST API |

```python
# RAG 패턴: 검색 결과를 프롬프트에 삽입
import chromadb

client = chromadb.Client()
collection = client.get_collection("project_docs")

# 관련 문서 검색
results = collection.query(query_texts=["인증 모듈"], n_results=3)
context = "\n".join(results["documents"][0])

# 에이전트에 컨텍스트로 전달
async for msg in query(
    prompt=f"다음 문서를 참고해서 답하세요:\n{context}\n\n질문: 인증 흐름을 설명해주세요.",
    options=ClaudeAgentOptions(...)
):
    ...
```

### 1-3. 그래프 데이터베이스

엔티티 간 **관계**가 중요한 지식을 저장할 때 사용한다.
"모듈 A가 모듈 B를 호출한다", "클래스 X가 인터페이스 Y를 구현한다" 같은
구조적 지식에 적합하다.

**Neo4j** (가장 범용적):
```cypher
-- 코드 의존성 그래프 예시
CREATE (auth:Module {name: "AuthService"})
CREATE (db:Module {name: "DatabaseService"})
CREATE (auth)-[:DEPENDS_ON]->(db)
```

```python
from neo4j import GraphDatabase

driver = GraphDatabase.driver("bolt://localhost:7687")
with driver.session() as session:
    deps = session.run(
        "MATCH (m:Module)-[:DEPENDS_ON]->(dep) WHERE m.name=$name RETURN dep.name",
        name="AuthService"
    ).data()
    context = f"AuthService 의존성: {[d['dep.name'] for d in deps]}"
```

### 1-4. 세션 기반 인메모리 (SDK 내장)

`ClaudeSDKClient`나 `resume` 옵션을 사용하면 이전 대화의 모든 내용
(파일 읽기 결과, 분석 내용, 결정 사항)이 세션에 보존된다.
**가장 권장하는 방식**: 별도 구현 없이 SDK가 자동 처리한다.

```python
# 1단계: 지식 수집 (세션 시작)
async for msg in query(prompt="프로젝트 전체를 읽고 파악해주세요", ...):
    if isinstance(msg, ResultMessage):
        session_id = msg.session_id  # 세션에 지식이 축적됨

# 2단계: 계획 수립 (같은 세션에서 — 앞의 지식이 그대로 유지)
async for msg in query(prompt="파악한 내용을 바탕으로 계획을 세워주세요",
                       options=ClaudeAgentOptions(resume=session_id)):
    ...
```

### 1-5. 외부 서비스 (MCP 연동)

Notion, Confluence, GitHub 등 외부 지식 저장소에 MCP를 통해 접근한다.

```python
options = ClaudeAgentOptions(
    mcp_servers={
        "notion": {"command": "npx", "args": ["-y", "@notionhq/notion-mcp-server"],
                   "env": {"NOTION_API_KEY": os.environ["NOTION_API_KEY"]}},
    },
    allowed_tools=["mcp__notion__*"]
)
```

### 1-6. 구조화된 메모리 (장기 기억)

에이전트 실행 결과를 JSON/DB에 저장해 다음 실행 시 참고한다.
워크플로우가 여러 번 반복 실행되거나 이전 결과를 기반으로 개선이 필요할 때 사용한다.

```python
import json
from pathlib import Path

MEMORY_FILE = Path(".agent_memory.json")

def load_memory() -> dict:
    if MEMORY_FILE.exists():
        return json.loads(MEMORY_FILE.read_text())
    return {"runs": [], "learnings": []}

def save_memory(memory: dict) -> None:
    MEMORY_FILE.write_text(json.dumps(memory, ensure_ascii=False, indent=2))
```

---

## 2. 계획 수립 전략

에이전트가 복잡한 작업을 수행하기 전에 어떻게 접근할지 결정하는 단계다.

### 2-1. ReAct (Reasoning + Acting)

가장 보편적인 에이전트 패턴. **추론(Thought) → 행동(Act) → 관찰(Observe)**을
반복한다. Claude Agent SDK의 기본 에이전트 루프가 이 패턴을 따른다.

```
Thought: 먼저 파일 구조를 파악해야 한다
Act: Glob("**/*.py") 실행
Observe: [auth.py, models.py, utils.py, ...]
Thought: auth.py가 핵심 파일이다. 내용을 읽겠다
Act: Read("auth.py") 실행
...
```

**SDK에서의 적용**: 별도 구현 없음. Claude가 자동으로 이 패턴으로 동작한다.

### 2-2. Plan-and-Execute (계획 후 실행)

먼저 **전체 계획을 수립**하고, 이후 각 단계를 순서대로 실행한다.
즉흥적인 ReAct와 달리 전체 그림을 먼저 확정하므로 **복잡하고 긴 작업**에 적합하다.

```python
# 1단계: 계획만 수립 (permission_mode="plan" 활용)
plan = None
async for msg in query(
    prompt="이 작업을 어떻게 수행할지 단계별 계획을 JSON으로 작성해주세요",
    options=ClaudeAgentOptions(
        output_format={  # 구조화된 출력으로 계획 강제
            "type": "json_schema",
            "schema": {
                "type": "object",
                "properties": {
                    "goal": {"type": "string"},
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "integer"},
                                "action": {"type": "string"},
                                "tools": {"type": "array", "items": {"type": "string"}},
                                "depends_on": {"type": "array", "items": {"type": "integer"}}
                            }
                        }
                    }
                }
            }
        }
    )
):
    if isinstance(msg, ResultMessage):
        plan = msg.structured_output

# 2단계: 계획 실행
for step in plan["steps"]:
    async for msg in query(prompt=f"실행: {step['action']}", ...):
        ...
```

### 2-3. Chain of Thought (사고 연쇄)

복잡한 문제를 **중간 추론 단계를 명시**하면서 해결한다.
Extended Thinking 기능을 활성화하면 Claude가 내부 추론을 더 깊이 수행한다.

```python
options = ClaudeAgentOptions(
    thinking={"type": "enabled", "budget_tokens": 10000},
    system_prompt=(
        "문제를 해결할 때 반드시:\n"
        "1. 문제를 정확히 정의하세요\n"
        "2. 가능한 접근법을 나열하세요\n"
        "3. 각 접근법의 장단점을 분석하세요\n"
        "4. 최선의 접근법을 선택하고 이유를 설명하세요\n"
        "5. 단계별로 실행하세요"
    )
)
```

### 2-4. 계층적 계획 (Hierarchical Planning)

**상위 에이전트(Orchestrator)**가 전체 계획을 세우고,
**하위 에이전트(Worker)**들이 각 서브태스크를 담당한다.
SDK의 `AgentDefinition`으로 구현한다.

```python
options = ClaudeAgentOptions(
    allowed_tools=["Agent"],
    agents={
        "planner": AgentDefinition(
            description="작업 계획 수립 전문가",
            prompt="주어진 목표를 달성하기 위한 구체적 단계를 계획합니다",
            tools=["Read", "Glob"]
        ),
        "executor": AgentDefinition(
            description="코드 작성 및 수정 전문가",
            prompt="계획에 따라 코드를 작성하고 수정합니다",
            tools=["Read", "Edit", "Write", "Bash"]
        ),
        "reviewer": AgentDefinition(
            description="코드 검토 전문가",
            prompt="작성된 코드를 검토하고 문제점을 찾습니다",
            tools=["Read", "Bash"]
        )
    }
)
```

### 2-5. Task Decomposition (WBS)

큰 목표를 **독립적으로 실행 가능한 최소 단위**로 분해한다.
각 태스크에 예상 도구, 의존성, 검증 기준을 명시한다.

```python
task_schema = {
    "tasks": [
        {
            "id": 1,
            "title": "의존성 분석",
            "subtasks": ["패키지 목록 수집", "버전 호환성 확인"],
            "tools": ["Bash", "Read"],
            "verification": "모든 패키지가 최신 버전",
            "depends_on": []
        },
        ...
    ]
}
```

---

## 3. 실행 전략

수립된 계획을 어떤 방식으로 실행하느냐에 따라 속도와 안정성이 달라진다.

### 3-1. 순차 실행 (Sequential)

각 단계를 순서대로 실행한다. 이전 단계의 결과가 다음 단계의 입력이 될 때 사용한다.

```python
session_id = None
for step in plan["steps"]:
    async for msg in query(
        prompt=step["action"],
        options=ClaudeAgentOptions(
            resume=session_id,  # 이전 단계의 컨텍스트 유지
            allowed_tools=step["tools"]
        )
    ):
        if isinstance(msg, ResultMessage):
            session_id = msg.session_id
```

**장점**: 컨텍스트 일관성 보장, 디버깅 쉬움  
**단점**: 느림 (병렬화 없음)

### 3-2. 병렬 서브에이전트 (Parallel Subagents)

독립적인 태스크를 동시에 실행한다. `asyncio.gather()`로 여러 `query()`를 병렬 실행한다.

```python
async def run_task(task: dict) -> dict:
    result = {}
    async for msg in query(prompt=task["action"], options=...):
        if isinstance(msg, ResultMessage):
            result = {"task_id": task["id"], "output": msg.result}
    return result

# 독립 태스크 병렬 실행
independent_tasks = [t for t in plan["steps"] if not t["depends_on"]]
results = await asyncio.gather(*[run_task(t) for t in independent_tasks])
```

**장점**: 대폭 빠름  
**단점**: 공유 상태(파일 동시 수정) 충돌 주의

### 3-3. Map-Reduce

여러 입력에 동일한 처리(Map)를 병렬 적용한 뒤 결과를 합산(Reduce)한다.
"모든 파일을 개별 분석 → 종합 보고서 작성" 패턴에 적합하다.

```python
# Map: 각 파일을 독립 에이전트로 분석
async def analyze_file(filepath: str) -> str:
    async for msg in query(prompt=f"{filepath}를 분석해주세요", ...):
        if isinstance(msg, ResultMessage):
            return msg.result
    return ""

file_list = ["auth.py", "models.py", "utils.py"]
analyses = await asyncio.gather(*[analyze_file(f) for f in file_list])

# Reduce: 개별 분석을 종합
combined = "\n\n".join(
    f"## {f}\n{a}" for f, a in zip(file_list, analyses)
)
async for msg in query(prompt=f"다음 분석들을 종합해주세요:\n{combined}", ...):
    ...
```

### 3-4. 이벤트 기반 파이프라인 (Event-Driven)

각 단계의 완료가 다음 단계를 트리거한다. `Monitor` 도구나 외부 큐(Redis, SQS)와 연동한다.

```python
async def run_pipeline(stages: list[dict]) -> None:
    context = {}
    for stage in stages:
        # 이전 단계 결과를 다음 단계 프롬프트에 주입
        prompt = stage["prompt_template"].format(**context)
        async for msg in query(prompt=prompt, options=stage["options"]):
            if isinstance(msg, ResultMessage):
                context[stage["output_key"]] = msg.result
                # 실패 시 파이프라인 중단
                if msg.subtype != "success":
                    raise RuntimeError(f"Stage '{stage['name']}' failed")
```

---

## 4. 결과 점검 전략

실행 결과가 올바른지 확인한다. 에이전트가 실수하거나 작업 목표에서 벗어날 수 있으므로
자동화된 점검이 필수다.

### 4-1. 자기 검토 (Self-Reflection)

같은 에이전트가 자신의 결과를 비판적으로 재검토한다.
시스템 프롬프트로 비판적 검토를 강제한다.

```python
async for msg in query(
    prompt=(
        "방금 작성한 코드를 다음 기준으로 스스로 검토해주세요:\n"
        "1. 버그가 없는가?\n"
        "2. 엣지 케이스를 모두 처리했는가?\n"
        "3. 보안 취약점은 없는가?\n"
        "문제가 발견되면 즉시 수정하세요."
    ),
    options=ClaudeAgentOptions(resume=session_id)
):
    ...
```

### 4-2. Critic 에이전트 (독립 검토자)

**별도의 에이전트**가 실행 결과를 검토한다.
같은 세션을 공유하지 않으므로 편향 없이 독립적으로 평가한다.

```python
async def critic_review(work_result: str) -> dict:
    """작업 결과를 독립 에이전트가 검토한다."""
    review = {}
    async for msg in query(
        prompt=(
            f"다음 작업 결과를 전문가 관점에서 검토해주세요:\n\n{work_result}\n\n"
            "통과 여부, 발견된 문제, 개선 제안을 JSON으로 반환하세요."
        ),
        options=ClaudeAgentOptions(
            system_prompt="당신은 엄격한 코드 리뷰어입니다. 모든 문제를 빠짐없이 지적하세요.",
            output_format={"type": "json_schema", "schema": critic_schema}
        )
    ):
        if isinstance(msg, ResultMessage):
            review = msg.structured_output
    return review
```

### 4-3. 테스트 실행 (Test Execution)

`Bash` 도구로 실제 테스트를 실행해 결과를 검증한다.
가장 객관적인 검증 방법이다.

```python
options = ClaudeAgentOptions(
    allowed_tools=["Bash"],
    system_prompt=(
        "작업이 완료되면 반드시:\n"
        "1. 관련 테스트를 모두 실행하세요 (pytest, bun test 등)\n"
        "2. 테스트가 실패하면 코드를 수정하세요\n"
        "3. 모든 테스트가 통과할 때까지 반복하세요"
    )
)
```

### 4-4. 체크리스트 기반 검증

작업 완료 조건을 명시적인 체크리스트로 정의하고 각 항목을 확인한다.

```python
CHECKLIST = [
    "모든 함수에 타입 힌트가 있는가?",
    "에러 핸들링이 구현되어 있는가?",
    "테스트가 통과하는가?",
    "문서가 업데이트되었는가?"
]

checklist_prompt = "다음 체크리스트를 확인하고 각 항목을 true/false로 반환하세요:\n"
checklist_prompt += "\n".join(f"- {item}" for item in CHECKLIST)
```

### 4-5. 반복 개선 루프 (Iterative Refinement)

품질 기준을 충족할 때까지 실행-검토-수정을 반복한다.

```python
MAX_ITERATIONS = 3

for iteration in range(MAX_ITERATIONS):
    # 실행
    await execute_step(session_id)
    
    # 검토
    review = await critic_review(session_id)
    
    if review["passed"]:
        print(f"✓ {iteration+1}회 만에 통과")
        break
    
    # 피드백 반영해 재실행
    feedback = "\n".join(review["issues"])
    print(f"반복 {iteration+1}: 문제 발견 → 수정 중...")
else:
    print("최대 반복 횟수 초과 — 수동 검토 필요")
```

---

## 5. 보고 및 공유 전략

작업 결과를 어떻게 전달하느냐에 따라 에이전트의 실용성이 결정된다.

### 5-1. 구조화된 출력 (Structured Output)

`output_format`으로 JSON 스키마를 강제하면 `ResultMessage.structured_output`에
파싱된 결과가 담긴다. 프로그래밍적으로 처리하기 가장 쉽다.

```python
options = ClaudeAgentOptions(
    output_format={
        "type": "json_schema",
        "schema": {
            "type": "object",
            "properties": {
                "summary": {"type": "string"},
                "severity": {"type": "string", "enum": ["low", "medium", "high", "critical"]},
                "issues": {"type": "array", "items": {"type": "string"}},
                "recommendations": {"type": "array", "items": {"type": "string"}}
            },
            "required": ["summary", "severity", "issues", "recommendations"]
        }
    }
)

async for msg in query(...):
    if isinstance(msg, ResultMessage):
        report = msg.structured_output  # 바로 사용 가능한 dict
```

### 5-2. 파일 저장

`Write` 도구를 사용해 마크다운, JSON, CSV 등 형식으로 보고서를 저장한다.

```python
# 에이전트가 직접 보고서를 파일로 저장하도록 지시
async for msg in query(
    prompt=(
        "분석 결과를 ./reports/audit_YYYYMMDD.md 파일로 저장해주세요.\n"
        "형식: 요약, 발견된 문제, 권장 조치, 다음 단계"
    ),
    options=ClaudeAgentOptions(allowed_tools=["Write"], permission_mode="acceptEdits")
):
    ...
```

### 5-3. MCP를 통한 외부 공유

| 채널 | MCP 서버 | 용도 |
|------|----------|------|
| **Slack** | `@modelcontextprotocol/server-slack` | 팀 알림 |
| **GitHub** | `@modelcontextprotocol/server-github` | 이슈/PR 생성 |
| **Notion** | `@notionhq/notion-mcp-server` | 문서화 |
| **Linear** | `@linear/linear-mcp` | 태스크 관리 |
| **Gmail** | Google Workspace MCP | 이메일 보고 |

```python
options = ClaudeAgentOptions(
    mcp_servers={
        "slack": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-slack"],
            "env": {"SLACK_BOT_TOKEN": os.environ["SLACK_BOT_TOKEN"]}
        }
    },
    allowed_tools=["mcp__slack__*"]
)

async for msg in query(
    prompt="분석 결과를 #engineering 채널에 요약해서 공유해주세요",
    options=options
):
    ...
```

### 5-4. Webhook (HTTP POST)

`Bash` 도구의 `curl`이나 `requests`로 외부 엔드포인트에 결과를 전송한다.

```python
# 에이전트 내부에서 webhook으로 보고
async for msg in query(
    prompt=(
        f"다음 JSON을 {webhook_url}에 POST 요청으로 전송해주세요:\n"
        f"{json.dumps(result)}"
    ),
    options=ClaudeAgentOptions(allowed_tools=["Bash"])
):
    ...
```

또는 SDK 코드에서 직접 전송:

```python
import httpx

async def send_webhook(url: str, payload: dict) -> None:
    async with httpx.AsyncClient() as client:
        await client.post(url, json=payload, timeout=30)
```

### 5-5. 알림 + 상세 보고서 분리

빠른 알림(Slack/이메일)과 상세 보고서(파일/Notion)를 병렬로 전송한다.

```python
# 보고서 파일 저장과 Slack 알림을 동시에
await asyncio.gather(
    save_report_to_file(report),
    send_slack_notification(report["summary"]),
    create_github_issue(report["critical_issues"])
)
```

---

## 전체 흐름 구현 시 고려사항

### 오류 처리

- 각 단계 실패 시 재시도 또는 폴백 전략 정의
- `ResultMessage.subtype`으로 성공/실패 구분: `"success"`, `"error_during_execution"`, `"error_max_turns"`

### 비용 관리

- `max_budget_usd` 옵션으로 단계별 비용 상한 설정
- `ResultMessage.total_cost_usd`로 누적 비용 추적

### 타임아웃

- `max_turns` 옵션으로 무한 루프 방지
- 단계별로 적절한 `max_turns` 설정 (계획: 5턴, 실행: 20턴)

### 감사 추적

- `PostToolUse` 훅으로 모든 도구 실행 로깅
- 세션 ID를 DB에 보관해 언제든 재현 가능하게 유지

---

## 실행

```bash
python with-workflow/workflow.py
bun run with-workflow/workflow.ts
```
