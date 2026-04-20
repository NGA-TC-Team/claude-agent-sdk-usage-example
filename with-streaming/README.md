# with-streaming — 스트리밍

## 스트리밍이란?

스트리밍은 **Claude가 텍스트를 생성하는 즉시, 완성되기 전에 실시간으로 수신하는 방식**이다.
응답 전체를 기다리지 않고 첫 글자부터 화면에 표시할 수 있다.

---

## 왜 스트리밍을 써야 하는가?

### 스트리밍 없을 때 (블로킹 방식)

```
사용자: "Python으로 웹 크롤러 만드는 법 알려줘"

[------ 8초 대기 ------]

Claude: 전체 응답이 한꺼번에 표시됨
```

1. **UX 문제**: 응답이 완성될 때까지 화면이 비어 있다. 사용자는 처리 중인지 멈춘 건지 모른다.
2. **타임아웃 위험**: 응답이 길수록 네트워크/서버 타임아웃에 걸릴 수 있다.
3. **부분 활용 불가**: 앞부분만 필요한 경우도 전체를 기다려야 한다.

### 스트리밍 사용 시

```
사용자: "Python으로 웹 크롤러 만드는 법 알려줘"

Claude: Python으로 웹 크롤러를 만들려면...    ← 즉시 표시 시작
        먼저 requests 라이브러리를...
        ...
```

- **TTFB(Time To First Byte) 단축**: 첫 텍스트가 즉시 표시됨
- **체감 응답 속도 향상**: 실제 속도는 같아도 빠르게 느껴짐
- **장문 응답 처리 안정**: 청크 단위로 수신해 타임아웃 위험 없음

---

## Agent SDK에서 스트리밍 활성화

`include_partial_messages=True` 옵션을 설정하면
`StreamEvent` 메시지가 추가로 yield된다.

```python
options = ClaudeAgentOptions(include_partial_messages=True)
```

### StreamEvent 구조

```python
@dataclass
class StreamEvent:
    uuid: str
    session_id: str
    event: dict  # 원시 Claude API 스트림 이벤트
    parent_tool_use_id: str | None
```

`event` 딕셔너리의 주요 타입:

| event["type"] | 설명 |
|---------------|------|
| `content_block_delta` | 텍스트 청크 도착. `event["delta"]["type"] == "text_delta"` |
| `content_block_start` | 새 content 블록 시작 |
| `content_block_stop` | content 블록 완료 |
| `message_delta` | 메시지 완료 신호 |

### 텍스트 추출 예시

```python
from claude_agent_sdk import StreamEvent

if isinstance(msg, StreamEvent):
    event = msg.event
    if (
        event.get("type") == "content_block_delta"
        and event.get("delta", {}).get("type") == "text_delta"
    ):
        print(event["delta"]["text"], end="", flush=True)
```

---

## 실행

```bash
python with-streaming/streaming.py
bun run with-streaming/streaming.ts
```
