/**
 * application-built-in/automation_app.ts — 이벤트 드리븐 자동화 워크플로우 (TS · 인프로세스)
 *
 * "inbox/ 폴더에 파일이 떨어지면 Claude가 자동 분류·요약해 processed/로 옮기는"
 * 백오피스 자동화 예제다. 고객 문의 · 에러 로그 · 인입 문서 트리아지 등에 즉시 확장 가능.
 *
 * 핵심 SDK 통합 포인트:
 *   1. `allowedTools: ["Read"]` + `cwd`로 권한 범위를 감시 폴더로 한정
 *   2. `outputFormat` JSON 스키마로 {category, priority, summary, action_items} 강제
 *   3. 훅(`PostToolUse`)으로 감사 로그 기록
 *   4. 작업당 `maxBudgetUsd`로 비용 폭주 방어
 *   5. 실패 건은 failed/ 폴더로 격리 (DLQ 역할)
 *
 * 실행:
 *   bun add @anthropic-ai/claude-agent-sdk
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   bun run application-built-in/automation_app.ts
 */

import { promises as fs, watch } from "node:fs";
import path from "node:path";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { formatCost, printResult } from "../utils/utils.ts";

type AnyMessage = Record<string, unknown>;

// ─── 경로 설정 ────────────────────────────────────────────────────────────────
const WORKSPACE = path.join(import.meta.dir, "workspace");
const INBOX = path.join(WORKSPACE, "inbox");
const PROCESSED = path.join(WORKSPACE, "processed");
const FAILED = path.join(WORKSPACE, "failed");
const AUDIT_LOG = path.join(WORKSPACE, "audit.log");

// ─── 스키마 ───────────────────────────────────────────────────────────────────
const CLASSIFY_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["bug_report", "feature_request", "complaint", "question", "other"],
      },
      priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
      summary: { type: "string", description: "2-3 문장 한국어 요약" },
      action_items: { type: "array", items: { type: "string" } },
      suggested_assignee: {
        type: "string",
        enum: ["support", "engineering", "product", "billing"],
      },
    },
    required: ["category", "priority", "summary", "action_items", "suggested_assignee"],
  },
};

const SYSTEM_PROMPT =
  "당신은 고객 지원 트리아지 자동화 에이전트입니다. " +
  "주어진 문서 파일을 읽고 분류·요약하세요. " +
  "파일 내용이 모호하면 'other'와 'low'로 분류하세요.";

// ─── 감사 로그 훅 ─────────────────────────────────────────────────────────────
const auditHook: HookCallback = async (input) => {
  const data = input as Record<string, unknown>;
  const ts = new Date().toISOString();
  const tool = (data.tool_name as string) ?? "?";
  const toolInput = JSON.stringify(data.tool_input ?? {}).slice(0, 200);
  await fs.appendFile(AUDIT_LOG, `[${ts}] ${tool}  ${toolInput}\n`);
  return {};
};

// ─── 파일 처리 ────────────────────────────────────────────────────────────────
async function processFile(filePath: string): Promise<void> {
  const name = path.basename(filePath);
  console.log(`→ 처리 시작: ${name}`);

  let result: Record<string, unknown> = {};
  let costUsd = 0;
  let status = "unknown";
  let sessionId: string | undefined;

  try {
    for await (const raw of query({
      prompt: `파일 \`inbox/${name}\`을(를) 읽고 정해진 스키마에 맞춰 분류·요약하세요.`,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        cwd: WORKSPACE,
        allowedTools: ["Read"],
        outputFormat: CLASSIFY_SCHEMA,
        maxTurns: 3,
        maxBudgetUsd: 0.03,
        hooks: { PostToolUse: [{ hooks: [auditHook] }] },
      },
    })) {
      const msg = raw as AnyMessage;
      if (msg.type === "result") {
        printResult(msg);
        result = (msg.structured_output as Record<string, unknown>) ?? {};
        costUsd = (msg.total_cost_usd as number) ?? 0;
        status = msg.subtype as string;
        sessionId = msg.session_id as string | undefined;
      }
    }
  } catch (err) {
    status = "exception";
    result = { error: (err as Error).message };
  }

  const ok = status === "success" && Object.keys(result).length > 0;
  const destDir = ok ? PROCESSED : FAILED;
  const destFile = path.join(destDir, name);
  const metaFile = path.join(destDir, `${path.parse(name).name}.meta.json`);

  await fs.mkdir(destDir, { recursive: true });
  await fs.rename(filePath, destFile);
  await fs.writeFile(
    metaFile,
    JSON.stringify(
      {
        filename: name,
        status,
        cost_usd: costUsd,
        session_id: sessionId,
        classification: result,
        processed_at: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(
    `✓ 저장: ${path.relative(WORKSPACE, destFile)}  |  cost ${formatCost(costUsd)}`
  );
}

// ─── 샘플 시드 ────────────────────────────────────────────────────────────────
const SAMPLES: Record<string, string> = {
  "ticket_001.txt":
    "안녕하세요, 오늘 오전부터 결제 화면에서 '서버 오류'가 뜨면서 결제가 완료되지 않습니다. " +
    "크롬·사파리 모두 동일하고, 환불 금액도 지연되고 있습니다. 긴급 확인 부탁드립니다.",
  "ticket_002.txt":
    "대시보드에 월별 매출 비교 그래프 기능을 추가해 주시면 좋겠습니다. " +
    "지금은 일별만 있는데 기획자 리뷰 때 월 단위가 훨씬 편합니다.",
  "ticket_003.txt":
    "SDK 문서 예제 오타 제보드립니다. 로그인 섹션의 `autneticate` → `authenticate` 입니다.",
};

async function seedSamples(): Promise<void> {
  for (const dir of [INBOX, PROCESSED, FAILED]) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(AUDIT_LOG, "", { flag: "a" });

  for (const [name, body] of Object.entries(SAMPLES)) {
    await fs.writeFile(path.join(INBOX, name), body, "utf-8");
  }
}

// ─── 감시 루프 ────────────────────────────────────────────────────────────────
async function watchAndProcess(targetCount: number): Promise<void> {
  let processed = 0;

  // 먼저 기존 파일 처리
  const existing = (await fs.readdir(INBOX)).sort();
  for (const name of existing) {
    const full = path.join(INBOX, name);
    const stat = await fs.stat(full);
    if (stat.isFile()) {
      await processFile(full);
      if (++processed >= targetCount) return;
    }
  }

  // 이후 신규 파일 감시
  await new Promise<void>((resolve) => {
    // 짧은 디바운스 — 쓰기 중간 이벤트 중복 방지
    const pending = new Map<string, ReturnType<typeof setTimeout>>();

    const watcher = watch(INBOX, { persistent: true }, (event, filename) => {
      if (event !== "rename" || !filename) return;
      const full = path.join(INBOX, filename);

      // 같은 파일에 대한 이전 타이머 취소
      const prev = pending.get(full);
      if (prev) clearTimeout(prev);

      pending.set(
        full,
        setTimeout(async () => {
          pending.delete(full);
          try {
            const stat = await fs.stat(full);
            if (!stat.isFile()) return;
          } catch {
            return; // 삭제·이동된 파일
          }
          await processFile(full);
          if (++processed >= targetCount) {
            watcher.close();
            resolve();
          }
        }, 200)
      );
    });
  });
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY 환경 변수가 필요합니다.");
    process.exit(1);
  }

  console.log(`▶ 자동화 워크스페이스: ${WORKSPACE}`);
  await seedSamples();
  console.log(`  시드 파일 ${Object.keys(SAMPLES).length}개 투입 → 처리 대기\n`);

  const t0 = Date.now();
  await watchAndProcess(Object.keys(SAMPLES).length);
  console.log(
    `\n[완료]  총 소요 ${((Date.now() - t0) / 1000).toFixed(1)}s  →  processed/ 확인`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
