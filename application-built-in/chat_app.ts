/**
 * application-built-in/chat_app.ts — 실시간 채팅 웹 앱 (TypeScript · 인프로세스 통합)
 *
 * "내가 만든 Bun.serve 웹 앱에 Claude Agent SDK를 심어 넣는" 최소 완성 예제다.
 *
 * 구성:
 *   - GET  /              — 초간단 채팅 UI (HTML, 인라인 문자열)
 *   - POST /chat/stream   — 프롬프트 받아 Claude 응답을 SSE(Server-Sent Events)로 스트리밍
 *
 * 핵심 SDK 통합 포인트:
 *   1. user_id 별 session_id를 인메모리 Map에 보관 → 재요청 시 `resume`으로 맥락 유지
 *   2. `includePartialMessages: true` + `stream_event`의 text_delta를 SSE 프레임으로 전달
 *   3. `maxTurns`, `maxBudgetUsd`로 단일 요청 비용 상한
 *   4. 시스템 프롬프트로 서비스 페르소나 고정
 *
 * 실행:
 *   bun add @anthropic-ai/claude-agent-sdk
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   bun run application-built-in/chat_app.ts
 *   # 브라우저 http://localhost:8000
 *
 * 테스트 (cURL로 SSE 소비):
 *   curl -N -X POST http://localhost:8000/chat/stream \
 *     -H "Content-Type: application/json" \
 *     -d '{"user_id": "alice", "message": "한 줄로 자기소개"}'
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { printResult } from "../utils/utils.ts";

type AnyMessage = Record<string, unknown>;

// ─── 전역 상태 ────────────────────────────────────────────────────────────────
// 프로덕션에선 Redis/Postgres. 본 예제는 데모용 인메모리.
const SESSIONS = new Map<string, string>(); // user_id -> session_id

const SYSTEM_PROMPT =
  "당신은 친절한 기술 어시스턴트입니다. " +
  "한국어로 간결히, 예시가 필요하면 짧은 코드 블록을 포함하세요.";

// ─── HTML ─────────────────────────────────────────────────────────────────────
const INDEX_HTML = `<!doctype html>
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

      log.insertAdjacentHTML("beforeend", \`<div class="u">🧑 \${message}</div>\`);
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
</html>`;

// ─── SSE 스트림 생성 ──────────────────────────────────────────────────────────
function sseFrame(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function claudeStream(userId: string, message: string): ReadableStream<Uint8Array> {
  const priorSession = SESSIONS.get(userId);

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const raw of query({
          prompt: message,
          options: {
            systemPrompt: SYSTEM_PROMPT,
            resume: priorSession,
            includePartialMessages: true,
            maxTurns: 6,
            // 단일 요청 비용 상한 — 무한 루프·폭주 방어
            maxBudgetUsd: 0.1,
          },
        })) {
          const msg = raw as AnyMessage;

          // 1) 세션 시작 시 session_id 캡처
          if (msg.type === "system" && msg.subtype === "init") {
            const sid = msg.session_id as string | undefined;
            if (sid) {
              SESSIONS.set(userId, sid);
              controller.enqueue(sseFrame({ type: "meta", session_id: sid }));
            }
          }

          // 2) 파셜 텍스트 — 실시간 전송
          else if (msg.type === "stream_event") {
            const ev = (msg as { event?: AnyMessage }).event ?? {};
            if (ev.type === "content_block_delta") {
              const delta = (ev.delta as AnyMessage) ?? {};
              if (delta.type === "text_delta") {
                controller.enqueue(
                  sseFrame({ type: "text", text: delta.text as string })
                );
              }
            }
          }

          // 3) 최종 결과 — 서버 로그 + 클라이언트 통지
          else if (msg.type === "result") {
            printResult(msg);
            controller.enqueue(
              sseFrame({
                type: "done",
                subtype: msg.subtype,
                cost_usd: msg.total_cost_usd,
                turns: msg.num_turns,
                session_id: msg.session_id,
              })
            );
          }
        }
      } catch (err) {
        controller.enqueue(
          sseFrame({ type: "error", message: (err as Error).message })
        );
      } finally {
        controller.close();
      }
    },
  });
}

// ─── 서버 ─────────────────────────────────────────────────────────────────────
function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY 환경 변수가 필요합니다.");
    process.exit(1);
  }

  const server = Bun.serve({
    port: 8000,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/") {
        return new Response(INDEX_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (req.method === "POST" && url.pathname === "/chat/stream") {
        const body = (await req.json()) as { user_id?: string; message?: string };
        if (!body.user_id || !body.message) {
          return new Response("user_id, message 필수", { status: 400 });
        }

        return new Response(claudeStream(body.user_id, body.message), {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`▶ ChatApp 기동  http://localhost:${server.port}`);
}

main();
