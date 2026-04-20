/**
 * application-built-in/saas_app.ts — 멀티테넌트 콘텐츠 생성 SaaS API (TS · 인프로세스)
 *
 * "Claude를 백엔드로 쓰는 B2B SaaS API를 내 앱에 심는" 최소 완성 예제다.
 * 단일 엔드포인트 `POST /api/v1/generate`로 테넌트별 마케팅 카피를 생성한다.
 *
 * 핵심 SDK 통합 포인트:
 *   1. API 키 헤더 `x-api-key`로 테넌트 식별 (HTTP 401 at 경계)
 *   2. 테넌트별 쿼터 · 누적 비용 추적 (HTTP 429 at 경계)
 *   3. `outputFormat` JSON 스키마로 구조화 출력
 *   4. `maxTurns: 2`, `maxBudgetUsd: 0.05`로 요청당 비용 상한
 *   5. `ResultMessage.total_cost_usd`를 테넌트 사용량 DB에 기록
 *
 * 실행:
 *   bun add @anthropic-ai/claude-agent-sdk
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   bun run application-built-in/saas_app.ts
 *
 * 테스트 cURL 시나리오는 saas_app.py 파일 상단 주석 참조.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { formatCost, printResult } from "../utils/utils.ts";

type AnyMessage = Record<string, unknown>;

// ─── 테넌트 DB (데모용) ───────────────────────────────────────────────────────
interface Tenant {
  id: string;
  apiKey: string;
  quota: number;
  usageCalls: number;
  usageCostUsd: number;
  recentSessions: string[];
}

const TENANTS = new Map<string, Tenant>();
for (const t of [
  { id: "tenant_a", apiKey: "tenant_a_secret", quota: 100 },
  { id: "tenant_b", apiKey: "tenant_b_secret", quota: 2 }, // 쿼터 초과 시연용
]) {
  TENANTS.set(t.apiKey, {
    ...t,
    usageCalls: 0,
    usageCostUsd: 0,
    recentSessions: [],
  });
}

// ─── 스키마 ───────────────────────────────────────────────────────────────────
const GENERATE_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      headline: { type: "string", description: "한 줄 헤드라인 (20자 내외)" },
      subheadline: { type: "string" },
      body: { type: "string", description: "3-5문장 본문 카피" },
      cta: { type: "string" },
      hashtags: { type: "array", items: { type: "string" } },
    },
    required: ["headline", "subheadline", "body", "cta", "hashtags"],
  },
};

const SYSTEM_PROMPT =
  "당신은 브랜드 마케팅 카피라이터입니다. " +
  "주어진 제품 brief를 바탕으로 간결하고 임팩트 있는 한국어 카피를 생성하세요. " +
  "고객 편익에 집중하고 과장·허위 주장을 피하세요.";

// ─── HTTP 경계 헬퍼 ──────────────────────────────────────────────────────────
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function authenticate(req: Request): Tenant | Response {
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey) return jsonResponse({ detail: "x-api-key 헤더 필요" }, 401);
  const tenant = TENANTS.get(apiKey);
  if (!tenant) return jsonResponse({ detail: "유효하지 않은 API 키" }, 401);
  return tenant;
}

// ─── 메인 핸들러 ─────────────────────────────────────────────────────────────
async function handleGenerate(req: Request): Promise<Response> {
  const authed = authenticate(req);
  if (authed instanceof Response) return authed;
  const tenant = authed;

  if (tenant.usageCalls >= tenant.quota) {
    return jsonResponse(
      { detail: `쿼터 초과 (${tenant.usageCalls}/${tenant.quota})` },
      429
    );
  }

  const body = (await req.json()) as { brief?: string };
  if (!body.brief) return jsonResponse({ detail: "brief 필드 필요" }, 400);

  let content: Record<string, unknown> = {};
  let costUsd = 0;
  let sessionId: string | undefined;
  let status = "unknown";

  for await (const raw of query({
    prompt: body.brief,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      outputFormat: GENERATE_SCHEMA,
      maxTurns: 2,
      maxBudgetUsd: 0.05,
    },
  })) {
    const msg = raw as AnyMessage;
    if (msg.type === "result") {
      printResult(msg);
      content = (msg.structured_output as Record<string, unknown>) ?? {};
      costUsd = (msg.total_cost_usd as number) ?? 0;
      sessionId = msg.session_id as string | undefined;
      status = msg.subtype as string;
    }
  }

  // 테넌트 사용량 기록 — 실전에선 트랜잭션 DB
  tenant.usageCalls += 1;
  tenant.usageCostUsd += costUsd;
  if (sessionId) {
    tenant.recentSessions.push(sessionId);
    if (tenant.recentSessions.length > 20) tenant.recentSessions.shift();
  }

  if (status !== "success" || Object.keys(content).length === 0) {
    return jsonResponse({ detail: `생성 실패 (status=${status})` }, 502);
  }

  return jsonResponse({
    content,
    usage: {
      tenant_id: tenant.id,
      calls_used: tenant.usageCalls,
      quota: tenant.quota,
      this_request_cost_usd: +costUsd.toFixed(6),
      cumulative_cost_usd: +tenant.usageCostUsd.toFixed(6),
    },
  });
}

function handleAdminUsage(): Response {
  const out: Record<string, unknown> = {};
  for (const t of TENANTS.values()) {
    out[t.id] = {
      calls_used: t.usageCalls,
      quota: t.quota,
      cost_usd: formatCost(t.usageCostUsd),
      recent_sessions: t.recentSessions.slice(-5),
    };
  }
  return jsonResponse(out);
}

// ─── 서버 ─────────────────────────────────────────────────────────────────────
function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY 환경 변수가 필요합니다.");
    process.exit(1);
  }

  const server = Bun.serve({
    port: 8001,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "POST" && url.pathname === "/api/v1/generate") {
        return handleGenerate(req);
      }
      if (req.method === "GET" && url.pathname === "/admin/usage") {
        return handleAdminUsage();
      }
      return jsonResponse({ detail: "Not Found" }, 404);
    },
  });

  console.log(`▶ SaaS API 기동  http://localhost:${server.port}`);
  console.log("  테넌트 A 키: tenant_a_secret  (쿼터 100)");
  console.log("  테넌트 B 키: tenant_b_secret  (쿼터 2 — 초과 시연용)");
}

main();
