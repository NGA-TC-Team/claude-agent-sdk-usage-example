# just-chat — 기본 채팅

Claude Agent SDK의 가장 기본적인 사용법을 다룬다.
`query()` 함수 하나로 Claude에게 메시지를 보내고 응답을 받는다.

---

## query() 함수

```python
async for message in query(prompt="...", options=ClaudeAgentOptions(...)):
    ...
```

`query()`는 비동기 제너레이터다. 호출하면 Claude가 응답을 완성할 때까지
여러 개의 메시지 객체를 순서대로 yield한다.

---

## 메시지 타입

| 타입 | 설명 |
|------|------|
| `AssistantMessage` | Claude의 응답. `content` 배열에 블록들이 담긴다 |
| `UserMessage` | 사용자 입력 (에코용) |
| `SystemMessage` | SDK 내부 이벤트. `subtype="init"`일 때 세션 ID 포함 |
| `ResultMessage` | 마지막으로 오는 완료 메시지. 비용·턴 수·세션 ID 포함 |

### AssistantMessage 내부 블록

| 블록 타입 | 설명 |
|-----------|------|
| `TextBlock` | 일반 텍스트 응답 |
| `ThinkingBlock` | Extended Thinking 사용 시 사고 과정 |
| `ToolUseBlock` | Claude가 도구를 호출할 때 |
| `ToolResultBlock` | 도구 실행 결과 |

---

## system_prompt

`ClaudeAgentOptions(system_prompt="...")` 으로 Claude의 역할과 행동 방식을 지정한다.
시스템 프롬프트는 대화 내내 유지된다.

```python
options = ClaudeAgentOptions(
    system_prompt="You are a senior Python developer. Answer concisely."
)
```

---

## 단일 턴 vs 에이전트 루프

`query()` 한 번 = **에이전트 루프 한 사이클**.
Claude는 도구(Bash, Read 등)를 여러 번 호출한 뒤 최종 응답을 반환한다.
이것이 단순 API 호출(`client.messages.create`)과 다른 점이다.
도구 없이 `system_prompt`만 쓰면 일반 채팅과 동일하게 동작한다.

---

## 실행

```bash
# Python
pip install claude-agent-sdk
export ANTHROPIC_API_KEY=sk-ant-...
python just-chat/chat.py

# TypeScript
bun add @anthropic-ai/claude-agent-sdk
export ANTHROPIC_API_KEY=sk-ant-...
bun run just-chat/chat.ts
```
