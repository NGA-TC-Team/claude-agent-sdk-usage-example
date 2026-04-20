"""
application-built-in/chat_app.py — 실시간 채팅 웹 앱 (Python · 인프로세스 통합)

"내가 만든 FastAPI 웹 앱에 Claude Agent SDK를 심어 넣는" 최소 완성 예제다.

구성:
  - GET  /                 — 초간단 채팅 UI (HTML, 인라인 문자열)
  - POST /chat/stream      — 프롬프트 받아 Claude 응답을 SSE(Server-Sent Events)로 스트리밍

핵심 SDK 통합 포인트:
  1. user_id 별 session_id를 인메모리 dict에 보관 → 재접속/재요청 시 `resume=`으로 맥락 유지
  2. `include_partial_messages=True` + StreamEvent의 text_delta를 SSE 프레임으로 전달
  3. `max_turns`, `max_budget_usd`로 단일 요청 비용 상한
  4. 시스템 프롬프트로 서비스 페르소나 고정

실행:
  pip install claude-agent-sdk fastapi uvicorn
  export ANTHROPIC_API_KEY=sk-ant-...
  python application-built-in/chat_app.py
  # 브라우저에서 http://localhost:8000 접속

테스트 (cURL로 SSE 소비):
  curl -N -X POST http://localhost:8000/chat/stream \
    -H "Content-Type: application/json" \
    -d '{"user_id": "alice", "message": "한 줄로 자기소개"}'
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import AsyncIterator

sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    query,
)

from utils.utils import print_result

# ─── 전역 상태 ────────────────────────────────────────────────────────────────
# 프로덕션에선 Redis/Postgres로 대체. 본 예제는 데모용 인메모리.
SESSIONS: dict[str, str] = {}  # user_id -> session_id

SYSTEM_PROMPT = (
    "당신은 친절한 기술 어시스턴트입니다. "
    "한국어로 간결히, 예시가 필요하면 짧은 코드 블록을 포함하세요."
)

# ─── 앱 ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="ChatApp with Claude Agent SDK")


class ChatRequest(BaseModel):
    user_id: str
    message: str


INDEX_HTML = """<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>Claude Chat</title>
  <style>
    body{font:14px system-ui;margin:0;padding:24px;max-width:720px;margin:auto}
    #log{border:1px solid #ddd;border-radius:8px;padding:12px;height:60vh;
         overflow:auto;white-space:pre-wrap;background:#fafafa}
    .u{color:#333;margin:8px 0} .a{color:#0b5;margin:8px 0}
    form{display:flex;gap:8px;margin-top:12px}
    input[type=text]{flex:1;padding:8px;border:1px solid #ccc;border-radius:6px}
    button{padding:8px 16px;border:0;background:#0b5;color:#fff;border-radius:6px}
  </style>
</head>
<body>
  <h1>Claude Chat</h1>
  <div id="log"></div>
  <form id="f">
    <input id="m" type="text" placeholder="메시지를 입력하세요" autofocus />
    <button>Send</button>
  </form>
  <script>
    const userId = "user_" + Math.random().toString(36).slice(2, 8);
    const log = document.getElementById("log");

    document.getElementById("f").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("m");
      const message = input.value.trim();
      if (!message) return;

      log.insertAdjacentHTML("beforeend", `<div class="u">🧑 ${message}</div>`);
      input.value = "";

      const assistantDiv = document.createElement("div");
      assistantDiv.className = "a";
      assistantDiv.textContent = "🤖 ";
      log.appendChild(assistantDiv);

      const res = await fetch("/chat/stream", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({user_id: userId, message}),
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, {stream: true});
        // SSE 프레임: "data: ...\\n\\n"
        for (const line of chunk.split("\\n")) {
          if (line.startsWith("data: ")) {
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === "text") assistantDiv.textContent += ev.text;
            } catch {}
          }
        }
        log.scrollTop = log.scrollHeight;
      }
    });
  </script>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return INDEX_HTML


async def _stream_claude(user_id: str, message: str) -> AsyncIterator[bytes]:
    """
    Claude 응답을 SSE 프레임으로 래핑해 yield하는 비동기 제너레이터.
    user_id로 세션을 식별해 이전 대화 맥락을 유지한다.
    """
    prior_session = SESSIONS.get(user_id)

    options = ClaudeAgentOptions(
        system_prompt=SYSTEM_PROMPT,
        # 기존 세션이 있으면 이어받기 — 사용자 맥락 유지
        resume=prior_session,
        # 실시간 text_delta를 받기 위한 옵션
        include_partial_messages=True,
        # 단일 요청 안전장치 — 무한 루프·비용 폭주 방지
        max_turns=6,
        max_budget_usd=0.10,
    )

    def sse(payload: dict) -> bytes:
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")

    try:
        async for msg in query(prompt=message, options=options):
            # 1) 세션 시작 시 session_id를 캡처
            if isinstance(msg, SystemMessage) and msg.subtype == "init":
                sid = msg.data.get("session_id")
                if sid:
                    SESSIONS[user_id] = sid
                    yield sse({"type": "meta", "session_id": sid})

            # 2) 파셜 텍스트 — 사용자에게 실시간으로 보냄
            elif isinstance(msg, StreamEvent):
                event = msg.event
                if event.get("type") == "content_block_delta":
                    delta = event.get("delta", {})
                    if delta.get("type") == "text_delta":
                        yield sse({"type": "text", "text": delta["text"]})

            # 3) 최종 결과 — 비용·상태 전달 및 서버 로그
            elif isinstance(msg, ResultMessage):
                print_result(msg)  # 서버 로그
                yield sse({
                    "type": "done",
                    "subtype": msg.subtype,
                    "cost_usd": msg.total_cost_usd,
                    "turns": msg.num_turns,
                    "session_id": msg.session_id,
                })

            # AssistantMessage는 StreamEvent로 이미 출력했으므로 무시

    except asyncio.CancelledError:
        # 클라이언트가 연결을 끊었을 때 graceful 처리
        raise
    except Exception as exc:
        yield sse({"type": "error", "message": str(exc)})


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest) -> StreamingResponse:
    return StreamingResponse(
        _stream_claude(req.user_id, req.message),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # nginx 버퍼링 방지
        },
    )


def main() -> None:
    import uvicorn

    if not os.getenv("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY 환경 변수가 필요합니다.")

    print("▶ ChatApp 기동  http://localhost:8000")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")


if __name__ == "__main__":
    main()
