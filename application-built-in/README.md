# application-built-in — 내가 만든 앱에 Claude Agent SDK 심기

기존 폴더들은 **SDK의 기능을 주제별로** 익히는 용도였다.
이 폴더는 한 단계 위의 질문에 답한다:

> "그 SDK를 내가 만드는 **실제 응용 프로그램**에 어떻게 집어넣을 것인가?"

---

## 1. SDK 통합 방법 4가지

응용 프로그램에 Claude Agent SDK를 심는 방법은 크게 4가지다.
"반드시 A로만 써야 한다"는 규칙은 없다.
앱 언어·배포 형태·트래픽 특성·상태 공유 요구에 따라 선택하면 된다.

| 방법 | 개념 | 적합한 상황 |
|------|------|-------------|
| **A. 인프로세스 (라이브러리)** | 앱 코드에서 SDK를 **직접 import** 하여 같은 프로세스에서 호출 | 앱 자체가 Python · Node · Bun |
| **B. 서브프로세스 (CLI/Runner)** | 앱이 Python·Node 스크립트나 `claude` CLI를 `spawn`·`exec`으로 띄워 **stdio JSON**으로 대화 | 앱이 Go · Rust · Java · C# · Ruby |
| **C. 사이드카 마이크로서비스** | Python/TS로 SDK 래퍼 **HTTP 서버**를 띄우고 메인 앱은 평범한 HTTP 클라이언트로 호출 | 다언어 조직 · 수평 확장 · K8s |
| **D. 작업 큐 워커** | 큐(Celery/BullMQ/SQS)에 작업 투입 → Python·TS 워커가 SDK로 처리 → 결과 콜백/저장 | 장시간 · 비동기 · 배치 |

### A. 인프로세스 (In-process Library)

앱 코드 한 줄에서 SDK를 import해 같은 프로세스 안에서 에이전트를 돌린다.
**가장 간단하다.** 본 폴더의 6개 예제가 모두 이 방식이다.

```python
# Python
from claude_agent_sdk import query
async for message in query(prompt="..."):
    ...
```

```ts
// TypeScript
import { query } from "@anthropic-ai/claude-agent-sdk";
for await (const message of query({ prompt: "..." })) { ... }
```

- **장점** — 최저 레이턴시, 네이티브 타입, 훅·세션·MCP 옵션 전 기능 접근, 배포 단순
- **단점** — 앱 언어가 Python/TS로 제한, SDK 내부 크래시가 앱 프로세스에 전파, 멀티스레드 경합
- **유의사항**
  - `ANTHROPIC_API_KEY`는 **환경 변수로만 주입** (코드·리포지토리 하드코딩 금지)
  - async 이터레이터를 중도에 `break`할 때 세션/프로세스가 깔끔히 정리되는지 확인 (`ClaudeSDKClient`의 `async with` 또는 `try/finally`)
  - `max_turns` · `max_budget_usd` 를 **무조건** 세팅 → 무한 루프 · 비용 폭주 방어
  - 동일 이벤트 루프 안에서 여러 `query()`를 병렬로 띄우면 레이트 리밋·토큰 경합이 발생하므로 `asyncio.Semaphore`로 동시성 상한 지정

### B. 서브프로세스 (Subprocess / CLI)

앱이 어떤 언어든, **SDK 바이너리를 자식 프로세스로 띄워** stdio로 JSON 메시지를 주고받는다.
Python/TS SDK도 내부적으로 이 프로토콜을 쓴다.

```go
// Go
cmd := exec.Command("claude",
    "--output-format=stream-json",
    "--input-format=stream-json",
    "--print")
stdin, _ := cmd.StdinPipe()
stdout, _ := cmd.StdoutPipe()
cmd.Start()

// 프롬프트를 JSON 한 줄로 보낸다
json.NewEncoder(stdin).Encode(map[string]any{
    "type": "user",
    "message": map[string]any{"role": "user", "content": "Hi"},
})
stdin.Close()

// 응답을 라인 단위로 파싱
scanner := bufio.NewScanner(stdout)
for scanner.Scan() {
    var msg map[string]any
    json.Unmarshal(scanner.Bytes(), &msg)
    // msg["type"] = "assistant" | "result" | "system" ...
}
```

- **장점** — 어떤 언어로도 가능, 앱 ↔ SDK 프로세스 **격리**, SDK 버전 독립 업그레이드
- **단점** — JSON 직렬화 비용, 상태 공유 어려움, 프로세스 수명 관리(재시작·좀비) 필요
- **유의사항**
  - **stdout은 JSON 메시지 전용**으로 간주 — 디버그 `print`는 stderr로
  - stdin 닫은 뒤 EPIPE 가능 → 쓰기/읽기를 **goroutine·thread 분리**하거나 비동기 I/O 사용
  - 프로세스 타임아웃 · kill 시 좀비 방지 (`cmd.Process.Kill()` + `Wait()`)
  - Windows에서 CLI 경로는 `claude.cmd` 래퍼가 아닌 바이너리를 직접 가리키는 편이 안전
  - 장기 실행 세션은 한 프로세스를 **재사용**해 cold-start 비용 상각

### C. 사이드카 마이크로서비스 (HTTP)

Python/TS로 SDK 래퍼 **HTTP 서버**를 하나 띄우고, 메인 앱은 어떤 언어든 HTTP로 호출한다.
본 폴더의 `chat_app.*` 과 `saas_app.*` 이 그대로 사이드카 역할을 한다.

```bash
# 어떤 언어에서도 이 한 줄이면 된다
curl -X POST http://localhost:8001/api/v1/generate \
  -H "Content-Type: application/json" \
  -H "x-api-key: tenant_a_secret" \
  -d '{"brief": "신형 헤드셋 런칭 카피 써줘"}'
```

- **장점** — **언어 중립** HTTP 계약, 수평 스케일, 블루/그린 배포, 관측·레이트리밋을 사이드카에 집중
- **단점** — 네트워크 홉 1개 추가, 상태는 Redis/DB로 외부화해야 함
- **유의사항**
  - 장시간 응답은 `Server-Sent Events` 혹은 WebSocket — 일반 HTTP 타임아웃 주의
  - **API 키는 사이드카 안에만** — 메인 앱 환경 변수에 노출 금지
  - 서킷 브레이커·타임아웃·레트라이 — 사이드카 장애가 메인 앱을 끌어내리지 않도록
  - 내부망일 땐 mTLS 또는 사설 네트워크로 제한, 외부 노출 땐 OAuth/JWT 추가

### D. 작업 큐 워커 (Async Worker)

요청을 큐에 넣고, Python·TS 워커 풀이 SDK로 처리한 뒤 결과를 DB/웹훅으로 전달.
본 폴더의 `automation_app.*` 이 파일 시스템 이벤트 기반의 (단일 노드) 큐 패턴이다.

```python
# Celery 예시 (개념)
@app.task(bind=True, max_retries=3)
def generate_article(self, tenant_id: str, brief: str) -> dict:
    async def _run():
        async for m in query(prompt=brief, options=opts):
            if isinstance(m, ResultMessage):
                return {"text": ..., "cost_usd": m.total_cost_usd}
    return asyncio.run(_run())
```

- **장점** — 폭주 트래픽 흡수, 자동 재시도, 크론·이벤트 트리거 친화
- **단점** — 비동기 배달 — 프런트엔드에 "진행률/완료" UI 필요, 엔드 투 엔드 지연
- **유의사항**
  - **멱등 키** 로 중복 실행 방지 (동일 트리거 재전송 대비)
  - **작업당** `max_budget_usd` 를 필수 지정 — 한 태스크가 전체 비용을 태우지 못하게
  - 실패는 DLQ(Dead Letter Queue)로 보내 재처리 가능하게
  - 긴 단일 쿼리는 중간 하트비트(30–60초) 로 "살아 있음"을 큐에 알림
  - 결과 전달은 **웹훅** 혹은 **폴링 엔드포인트** 중 고객사 네트워크에 맞는 쪽을 선택

### 어느 것을 고를까?

```
앱이 Python/TS인가?                              ─► A. 인프로세스
앱이 타언어 + 단일 서버 + 저지연 요구              ─► B. 서브프로세스
앱이 타언어 + 멀티 서비스 + 수평 확장 필요        ─► C. 사이드카
작업이 길거나 배치 · 이벤트 트리거 · 재시도 필요   ─► D. 큐 워커
```

실제 프로덕션에선 **혼합**이 흔하다. 예) 사용자 요청은 C(사이드카), 야간 재처리 배치는 D(큐), 내부 CLI 툴은 A(인프로세스).

---

## 2. "Python이나 TypeScript만 써야 한다"는 오해

SDK 공식 바인딩이 Python·TypeScript로 나오기 때문에 "이 둘 중 하나가 아니면 못 쓴다"고 오해하기 쉽다. 사실은 그렇지 않다.

### 왜 어떤 언어로도 가능한가

Claude Agent SDK의 **실제 실행 주체는 Claude Code 바이너리**다.
Python·TS 패키지는 이 바이너리를 서브프로세스로 띄워 **stdio 위의 JSON 프로토콜**로 대화하는 얇은 래퍼일 뿐이다.

```
┌──────────────┐    stdio JSON    ┌────────────────┐
│ 내가 만든 앱 │ ───────────────► │ claude 바이너리│
│ (어떤 언어)  │ ◄─────────────── │ (에이전트 루프)│
└──────────────┘                  └────────────────┘
```

즉 **이 JSON 프로토콜을 말할 수만 있으면** 언어는 무엇이든 상관없다.

### 네 가지 언어로 본 증명

#### Go — `os/exec`

```go
package main

import (
    "bufio"; "encoding/json"; "fmt"; "os/exec"
)

func main() {
    cmd := exec.Command("claude",
        "--output-format=stream-json",
        "--input-format=stream-json", "--print")
    stdin, _  := cmd.StdinPipe()
    stdout, _ := cmd.StdoutPipe()
    _ = cmd.Start()

    json.NewEncoder(stdin).Encode(map[string]any{
        "type": "user",
        "message": map[string]any{"role": "user", "content": "한 줄 자기소개"},
    })
    stdin.Close()

    sc := bufio.NewScanner(stdout)
    for sc.Scan() {
        var m map[string]any
        _ = json.Unmarshal(sc.Bytes(), &m)
        if m["type"] == "assistant" {
            fmt.Println(m)
        }
    }
    _ = cmd.Wait()
}
```

#### Rust — `tokio::process`

```rust
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut child = Command::new("claude")
        .args(["--output-format=stream-json",
               "--input-format=stream-json", "--print"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()?;

    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(br#"{"type":"user","message":{"role":"user","content":"hi"}}"#).await?;
    stdin.write_all(b"\n").await?;
    drop(stdin);

    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    while let Some(line) = lines.next_line().await? {
        let v: serde_json::Value = serde_json::from_str(&line)?;
        if v["type"] == "assistant" { println!("{v}"); }
    }
    Ok(())
}
```

#### Java / Kotlin — `ProcessBuilder`

```kotlin
import com.fasterxml.jackson.databind.ObjectMapper
import java.io.BufferedReader

fun main() {
    val proc = ProcessBuilder(
        "claude", "--output-format=stream-json",
        "--input-format=stream-json", "--print"
    ).redirectErrorStream(false).start()

    val mapper = ObjectMapper()
    proc.outputStream.bufferedWriter().use { w ->
        w.write(mapper.writeValueAsString(mapOf(
            "type" to "user",
            "message" to mapOf("role" to "user", "content" to "hi")
        )))
        w.newLine()
    }

    BufferedReader(proc.inputStream.reader()).forEachLine { line ->
        val node = mapper.readTree(line)
        if (node["type"]?.asText() == "assistant") println(node)
    }
    proc.waitFor()
}
```

#### cURL — HTTP 사이드카 호출

가장 짧은 증명. 본 폴더의 `saas_app.py`(또는 `.ts`)를 사이드카로 띄워 두면 **어떤 언어에서든 한 줄**로 호출된다.

```bash
curl -X POST http://localhost:8001/api/v1/generate \
  -H "Content-Type: application/json" \
  -H "x-api-key: tenant_a_secret" \
  -d '{"brief": "신형 헤드셋 런칭 카피"}'
```

### Anthropic Client SDK(직접 호출) 와의 차이

| 항목 | Agent SDK (B·C 방식 포함) | Anthropic Client SDK (REST) |
|------|---------------------------|-----------------------------|
| 공식 지원 언어 | Python, TypeScript (+ CLI 프로토콜로 사실상 전 언어) | Python, TS, Java, Go, Ruby, .NET 등 10+ |
| 에이전트 루프 | 자동 | 직접 구현 |
| 파일 · 셸 도구 | 빌트인(`Read`·`Bash` 등) | 없음 (직접 정의) |
| 세션 영속 | 디스크 자동 | 직접 설계 |
| 적합한 경우 | **자율 에이전트**, 코드 편집·자동화 | 단순 Q&A, 프롬프트-완료형 호출 |

> 결론: "공식 SDK 언어가 Python/TS" 라는 건 **편리한 바인딩**의 범위일 뿐, 능력의 상한이 아니다.

---

## 3. 이 폴더의 예제 (A. 인프로세스)

| 파일 | 앱 유형 | 핵심 SDK 통합 포인트 |
|------|---------|----------------------|
| `chat_app.py` · `chat_app.ts` | 실시간 채팅 웹 앱 | 세션 유지(`resume`), 파셜 메시지 스트리밍(SSE) |
| `saas_app.py` · `saas_app.ts` | 멀티테넌트 SaaS API | API 키 인증, 테넌트 쿼터, `output_format` JSON, `max_budget_usd` |
| `automation_app.py` · `automation_app.ts` | 이벤트 드리븐 자동화 | 폴더 감시, `allowed_tools`, 구조화 출력, 처리 결과 영속화 |

### 설치

```bash
# Python
pip install claude-agent-sdk fastapi uvicorn watchfiles

# TypeScript (Bun)
bun add @anthropic-ai/claude-agent-sdk

# 환경 변수
export ANTHROPIC_API_KEY=sk-ant-...
```

### 실행

```bash
# 1) 채팅 앱 — 브라우저 http://localhost:8000 접속
python application-built-in/chat_app.py
bun run application-built-in/chat_app.ts

# 2) SaaS API — cURL 3종 시나리오
python application-built-in/saas_app.py
bun run application-built-in/saas_app.ts
#
# 정상 요청
# curl -X POST http://localhost:8001/api/v1/generate \
#   -H "x-api-key: tenant_a_secret" -H "content-type: application/json" \
#   -d '{"brief": "노이즈캔슬링 헤드셋 런칭 카피"}'
#
# 잘못된 키 (401)
# curl -X POST http://localhost:8001/api/v1/generate \
#   -H "x-api-key: wrong" -H "content-type: application/json" -d '{"brief":"x"}'
#
# 쿼터 초과 (429) — tenant_b_secret 으로 3회 이상 호출

# 3) 자동화 — inbox/ 에 샘플 3개 자동 투입, processed/ 결과 확인
python application-built-in/automation_app.py
bun run application-built-in/automation_app.ts
```

### 공통 종료 시그니처

모든 예제는 기존 레포 컨벤션대로 아래 라인을 서버 로그 또는 표준 출력 마지막에 찍는다.

```
[done: success | turns: N | cost: $0.XXXX | session: ...]
```

---

## 4. 구현 시 체크리스트

내 앱에 SDK를 심을 때 한 번씩 점검하면 좋은 목록이다.

**보안**
- [ ] API 키는 **환경 변수만** (프런트엔드/리포지토리 절대 금지)
- [ ] `allowed_tools` 로 **최소 권한** — 읽기 전용/편집 허용을 필요한 만큼만
- [ ] `permission_mode`를 프로덕션에선 `acceptEdits` 또는 명시적 훅으로 제어, `bypassPermissions`는 금지
- [ ] 사용자 입력을 시스템 프롬프트에 그대로 이어붙이지 않음(프롬프트 인젝션 대비)

**비용·안정성**
- [ ] `max_turns` 지정
- [ ] `max_budget_usd` 지정 (작업당·세션당 둘 다)
- [ ] `ResultMessage.total_cost_usd` 를 메트릭으로 수집
- [ ] 타임아웃·서킷 브레이커 — SDK 호출이 앱 전체를 못 끌어내리게

**운영**
- [ ] 세션 `session_id` 로깅 → 장애 재현용
- [ ] 훅(`PostToolUse`)으로 감사 로그 필요 여부 판단
- [ ] 구조화 출력(`output_format` JSON) 사용 시 **스키마 검증 실패**도 응답 케이스로 포함
- [ ] MCP 서버 사용 시 `SystemMessage(init)` 에서 연결 실패를 **명확히** 에러 처리

**확장**
- [ ] 동시 호출 제한 (세마포어·큐·레이트리미터)
- [ ] 큰 입력은 파일로 전달 후 `Read` 도구 허용 — 토큰 절감
- [ ] 프롬프트 캐시 활용 가능한 안정 프롬프트는 상단에 배치

---

## 참고

- 레포 루트 [ReadMe.md](../ReadMe.md) — SDK 전반 · 기능별 예제 안내
- [jargon.md](../jargon.md) — 용어 사전
- [Agent SDK 개요](https://code.claude.com/docs/en/agent-sdk/overview)
- [CLI 참조 (stdio 프로토콜)](https://code.claude.com/docs/en/cli-reference)
- [Anthropic Client SDK (REST, 10+ 언어)](https://docs.claude.com/en/api/client-sdks)
