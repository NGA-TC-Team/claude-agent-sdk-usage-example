/**
 * with-workflow/workflow.ts — AI 에이전트 워크플로우 예제 (TypeScript)
 *
 * "코드베이스 감사 에이전트"를 통해 5단계 워크플로우를 구현한다:
 *
 *   1. GATHER  — 지식 수집: 프로젝트 파일 탐색 및 구조 파악
 *   2. PLAN    — 계획 수립: structured output으로 감사 계획 JSON 생성
 *   3. EXECUTE — 실행: 계획 단계별 순차/병렬 실행
 *   4. VERIFY  — 결과 점검: 독립 Critic 에이전트 검토 + 반복 개선
 *   5. REPORT  — 보고: 구조화 출력 + 마크다운 파일 저장
 */

import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFile, mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatCost, printResult } from "../utils/utils.ts";

// ─── 경로 설정 ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const REPORT_DIR = join(__dirname, "reports");
const AUDIT_LOG = join(__dirname, "workflow_audit.log");

type AnyMessage = Record<string, unknown>;

// ─── 스키마 정의 ──────────────────────────────────────────────────────────────

const PLAN_SCHEMA = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      goal: { type: "string" },
      scope: { type: "string" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            phase: { type: "string" },
            action: { type: "string" },
            tools: { type: "array", items: { type: "string" } },
            depends_on: { type: "array", items: { type: "integer" } },
          },
          required: ["id", "phase", "action", "tools", "depends_on"],
        },
      },
    },
    required: ["goal", "scope", "steps"],
  },
};

const CRITIC_SCHEMA = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      passed: { type: "boolean" },
      score: { type: "number", minimum: 0, maximum: 10 },
      issues: { type: "array", items: { type: "string" } },
      suggestions: { type: "array", items: { type: "string" } },
    },
    required: ["passed", "score", "issues", "suggestions"],
  },
};

const REPORT_SCHEMA = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
      findings: { type: "array", items: { type: "string" } },
      recommendations: { type: "array", items: { type: "string" } },
      next_steps: { type: "array", items: { type: "string" } },
    },
    required: ["title", "summary", "severity", "findings", "recommendations", "next_steps"],
  },
};

// ─── 공통 유틸 ────────────────────────────────────────────────────────────────

async function log(phase: string, message: string): Promise<void> {
  const timestamp = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  const line = `[${timestamp}] [${phase}] ${message}`;
  console.log(line);
  await appendFile(AUDIT_LOG, line + "\n", "utf-8").catch(() => {});
}

function extractText(message: AnyMessage): string {
  if (message.type !== "assistant") return "";
  const content = (message.message as { content: AnyMessage[] }).content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text as string)
    .join("\n");
}

function makeToolHook(phase: string): HookCallback {
  /**
   * PostToolUse 훅: 각 단계의 도구 실행을 로그에 기록한다.
   */
  return async (input) => {
    const data = input as Record<string, unknown>;
    const toolName = (data.tool_name as string) ?? "?";
    const toolInput = (data.tool_input as Record<string, string>) ?? {};
    const detail = toolInput.file_path ?? toolInput.command ?? "";
    await log(phase, `  ↳ ${toolName}(${detail.slice(0, 60)})`);
    return {};
  };
}

// ─── 단계 1: 지식 수집 (GATHER) ───────────────────────────────────────────────

async function gatherKnowledge(): Promise<string> {
  /**
   * 프로젝트 파일 구조를 탐색하고 핵심 내용을 파악한다.
   * Read, Glob, Grep만 허용 — 읽기 전용으로 안전하게 실행한다.
   */
  await log("GATHER", "프로젝트 파일 탐색 시작");

  let sessionId: string | undefined;

  for await (const message of query({
    prompt:
      "이 Python 프로젝트의 구조를 파악해주세요.\n" +
      "1. 모든 .py 파일 목록을 확인하세요\n" +
      "2. 각 파일의 주요 함수/클래스를 파악하세요\n" +
      "3. 파일 간 import 관계를 분석하세요\n" +
      "4. 전체 구조를 간결하게 요약해주세요",
    options: {
      allowedTools: ["Read", "Glob", "Grep"],
      cwd: PROJECT_ROOT,
      hooks: {
        PostToolUse: [{ hooks: [makeToolHook("GATHER")] }],
      },
    },
  })) {
    const msg = message as AnyMessage;
    const text = extractText(msg);
    if (text) process.stdout.write("  " + text + "\n");

    if (msg.type === "result") {
      sessionId = msg.session_id as string;
      await log(
        "GATHER",
        `완료 | 비용: ${formatCost(msg.total_cost_usd as number)} | 세션: ${sessionId.slice(0, 16)}...`
      );
      printResult(msg);
    }
  }

  if (!sessionId) throw new Error("지식 수집 단계 실패: session_id를 얻지 못했습니다");
  return sessionId;
}

// ─── 단계 2: 계획 수립 (PLAN) ─────────────────────────────────────────────────

async function createPlan(sessionId: string): Promise<[Record<string, unknown>, string]> {
  /**
   * 수집한 지식을 바탕으로 감사 계획을 JSON으로 수립한다.
   * outputFormat으로 계획이 정해진 스키마를 따르도록 강제한다.
   */
  await log("PLAN", "감사 계획 수립 중...");

  let plan: Record<string, unknown> = {};
  let newSessionId = sessionId;

  for await (const message of query({
    prompt:
      "파악한 프로젝트를 감사하기 위한 단계별 계획을 수립해주세요.\n" +
      "각 단계에 필요한 도구와 의존 관계를 명시해주세요.\n" +
      "최대 5단계로 작성하세요.",
    options: {
      resume: sessionId,
      allowedTools: ["Read"],
      outputFormat: PLAN_SCHEMA,
      systemPrompt:
        "당신은 시니어 소프트웨어 감사 전문가입니다. " +
        "파악한 프로젝트 구조를 바탕으로 코드 품질 감사 계획을 수립하세요. " +
        "각 단계는 독립적으로 실행 가능해야 합니다.",
    },
  })) {
    const msg = message as AnyMessage;
    if (msg.type === "result") {
      plan = (msg.structured_output as Record<string, unknown>) ?? {};
      newSessionId = msg.session_id as string;
      const steps = (plan.steps as unknown[]) ?? [];
      await log("PLAN", `계획 수립 완료 | ${steps.length}개 단계`);
      printResult(msg);
    }
  }

  if (!(plan.steps as unknown[])?.length) {
    throw new Error("계획 수립 실패: 유효한 계획이 생성되지 않았습니다");
  }

  // 계획을 파일로 저장 (감사 추적용)
  await mkdir(REPORT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const planFile = join(REPORT_DIR, `plan_${timestamp}.json`);
  await writeFile(planFile, JSON.stringify(plan, null, 2), "utf-8");
  await log("PLAN", `계획 저장: plan_${timestamp}.json`);

  return [plan, newSessionId];
}

// ─── 단계 3: 실행 (EXECUTE) ───────────────────────────────────────────────────

type Step = {
  id: number;
  phase: string;
  action: string;
  tools: string[];
  depends_on: number[];
};

async function executeStep(
  step: Step,
  sessionId: string
): Promise<[string, string]> {
  /**
   * 계획의 단일 단계를 실행한다.
   * 세션을 resume해 이전 단계의 컨텍스트를 유지한다.
   */
  let stepResult = "";
  let newSessionId = sessionId;

  for await (const message of query({
    prompt: `다음 감사 단계를 수행해주세요: ${step.action}`,
    options: {
      resume: sessionId,
      allowedTools: step.tools.length ? step.tools : ["Read"],
      permissionMode: "acceptEdits",
      hooks: {
        PostToolUse: [{ hooks: [makeToolHook(`EXECUTE-${step.id}`)] }],
      },
      cwd: PROJECT_ROOT,
    },
  })) {
    const msg = message as AnyMessage;
    const text = extractText(msg);
    if (text) stepResult += text + "\n";

    if (msg.type === "result") {
      newSessionId = msg.session_id as string;
      await log(
        "EXECUTE",
        `  단계 ${step.id} 완료 | 비용: ${formatCost(msg.total_cost_usd as number)}`
      );
    }
  }

  return [stepResult.trim(), newSessionId];
}

async function executePlan(
  plan: Record<string, unknown>,
  sessionId: string
): Promise<[string, string]> {
  /**
   * 계획 전체를 실행한다.
   * 의존성이 없는 단계들은 병렬로, 의존성이 있는 단계들은 순차로 실행한다.
   */
  const steps = plan.steps as Step[];
  await log("EXECUTE", `${steps.length}개 단계 실행 시작`);

  const completed = new Map<number, string>(); // step_id → result
  let currentSessionId = sessionId;

  // 의존성 없는 단계 — 병렬 실행
  const independent = steps.filter((s) => s.depends_on.length === 0);
  if (independent.length > 1) {
    await log("EXECUTE", `독립 단계 ${independent.length}개 병렬 실행`);
    const results = await Promise.all(
      independent.map((s) => executeStep(s, currentSessionId))
    );
    independent.forEach((step, i) => {
      completed.set(step.id, results[i][0]);
    });
  } else {
    for (const step of independent) {
      const [result, nextSession] = await executeStep(step, currentSessionId);
      completed.set(step.id, result);
      currentSessionId = nextSession;
    }
  }

  // 의존성 있는 단계 — 순차 실행
  const dependent = steps.filter((s) => s.depends_on.length > 0);
  for (const step of dependent) {
    if (step.depends_on.every((id) => completed.has(id))) {
      await log("EXECUTE", `단계 ${step.id} [${step.phase}] 시작`);
      const [result, nextSession] = await executeStep(step, currentSessionId);
      completed.set(step.id, result);
      currentSessionId = nextSession;
    }
  }

  // 모든 결과 합산
  const allResults = Array.from(completed.entries())
    .sort(([a], [b]) => a - b)
    .filter(([, r]) => r)
    .map(([id, result]) => {
      const step = steps.find((s) => s.id === id);
      return `### 단계 ${id}: ${step?.action ?? ""}\n${result}`;
    })
    .join("\n\n---\n\n");

  await log("EXECUTE", `전체 실행 완료 | ${completed.size}개 단계`);
  return [allResults, currentSessionId];
}

// ─── 단계 4: 결과 점검 (VERIFY) ───────────────────────────────────────────────

async function verifyWithCritic(
  executionResult: string
): Promise<Record<string, unknown>> {
  /**
   * 독립 Critic 에이전트가 실행 결과를 검토한다.
   * 원래 세션과 독립적으로 실행되어 편향 없는 평가를 보장한다.
   */
  await log("VERIFY", "독립 Critic 에이전트 검토 시작");

  let review: Record<string, unknown> = {};

  for await (const message of query({
    prompt:
      `다음 코드 감사 결과를 검토해주세요:\n\n` +
      `${executionResult.slice(0, 3000)}\n\n` +
      `검토 기준:\n` +
      `1. 감사 항목이 충분히 다루어졌는가?\n` +
      `2. 발견된 문제들이 정확한가?\n` +
      `3. 권장 조치가 실행 가능한가?\n` +
      `4. 누락된 중요 항목은 없는가?`,
    options: {
      // 독립 세션 — resume 없음
      systemPrompt:
        "당신은 엄격한 시니어 코드 감사 전문가입니다. " +
        "다음 감사 결과를 비판적으로 검토하세요. " +
        "모든 문제를 빠짐없이 지적하고, 누락된 항목이 있으면 반드시 언급하세요.",
      outputFormat: CRITIC_SCHEMA,
    },
  })) {
    const msg = message as AnyMessage;
    if (msg.type === "result") {
      review = (msg.structured_output as Record<string, unknown>) ?? {};
      const passed = review.passed as boolean;
      const score = review.score as number;
      const issuesCount = (review.issues as unknown[])?.length ?? 0;
      await log(
        "VERIFY",
        `검토 완료 | 통과: ${passed} | 점수: ${score}/10 | 문제: ${issuesCount}개`
      );
    }
  }

  return review;
}

async function verifyWithIteration(
  plan: Record<string, unknown>,
  executionResult: string,
  sessionId: string,
  maxIterations = 2
): Promise<[string, string]> {
  /**
   * Critic 검토 결과를 바탕으로 반복 개선한다.
   */
  let currentResult = executionResult;
  let currentSession = sessionId;

  for (let i = 0; i < maxIterations; i++) {
    const review = await verifyWithCritic(currentResult);

    if (review.passed) {
      await log("VERIFY", `✓ ${i + 1}회 검토 통과 (점수: ${review.score}/10)`);
      break;
    }

    const issues = (review.issues as string[]) ?? [];
    const suggestions = (review.suggestions as string[]) ?? [];

    if (!issues.length) {
      await log("VERIFY", "검토 통과 (문제 없음)");
      break;
    }

    await log("VERIFY", `반복 ${i + 1}: ${issues.length}개 문제 발견 → 개선 중`);

    const feedback = issues.map((iss) => `- ${iss}`).join("\n");
    const suggestionText = suggestions.map((s) => `- ${s}`).join("\n");
    let extraResult = "";

    for await (const message of query({
      prompt:
        `검토에서 다음 문제가 발견되었습니다:\n${feedback}\n\n` +
        `개선 제안:\n${suggestionText}\n\n` +
        `위 문제들을 보완해서 감사를 보완해주세요.`,
      options: {
        resume: currentSession,
        allowedTools: ["Read", "Bash", "Glob", "Grep"],
        cwd: PROJECT_ROOT,
      },
    })) {
      const msg = message as AnyMessage;
      extraResult += extractText(msg);
      if (msg.type === "result") {
        currentSession = msg.session_id as string;
      }
    }

    currentResult = currentResult + "\n\n### 보완 분석\n" + extraResult;
  }

  return [currentResult, currentSession];
}

// ─── 단계 5: 보고 (REPORT) ────────────────────────────────────────────────────

function buildMarkdownReport(
  report: Record<string, unknown>,
  plan: Record<string, unknown>,
  timestamp: string
): string {
  const severityEmoji: Record<string, string> = {
    low: "🟢", medium: "🟡", high: "🟠", critical: "🔴",
  };
  const sev = (report.severity as string) ?? "low";
  const emoji = severityEmoji[sev] ?? "⚪";
  const findings = (report.findings as string[]) ?? [];
  const recommendations = (report.recommendations as string[]) ?? [];
  const nextSteps = (report.next_steps as string[]) ?? [];

  return [
    `# ${report.title ?? "코드 감사 보고서"}`,
    `\n> 생성 일시: ${timestamp} | 심각도: ${emoji} ${sev.toUpperCase()}`,
    "\n## 요약\n",
    report.summary ?? "",
    "\n## 주요 발견 사항\n",
    ...findings.map((f) => `- ${f}`),
    "\n## 권장 조치\n",
    ...recommendations.map((r) => `- ${r}`),
    "\n## 다음 단계\n",
    ...nextSteps.map((s, i) => `${i + 1}. ${s}`),
    `\n---\n*감사 계획 목표: ${plan.goal ?? ""}*`,
  ].join("\n");
}

async function generateReport(
  plan: Record<string, unknown>,
  executionResult: string,
  sessionId: string
): Promise<Record<string, unknown>> {
  /**
   * 감사 결과를 구조화된 보고서로 생성하고 마크다운 파일로 저장한다.
   */
  await log("REPORT", "최종 보고서 생성 중...");

  let report: Record<string, unknown> = {};
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  for await (const message of query({
    prompt:
      "지금까지의 감사 작업을 종합해 최종 보고서를 작성해주세요.\n" +
      "summary는 3문장 이내로 핵심만 담아주세요.\n" +
      "severity는 발견된 문제의 최고 심각도를 기준으로 판단하세요.",
    options: {
      resume: sessionId,
      outputFormat: REPORT_SCHEMA,
      systemPrompt:
        "당신은 기술 보고서 작성 전문가입니다. " +
        "감사 결과를 경영진과 개발팀 모두가 이해할 수 있는 명확한 보고서로 작성하세요.",
    },
  })) {
    const msg = message as AnyMessage;
    if (msg.type === "result") {
      report = (msg.structured_output as Record<string, unknown>) ?? {};
      await log("REPORT", `보고서 생성 완료 | 심각도: ${(report.severity as string ?? "?").toUpperCase()}`);
      printResult(msg);
    }
  }

  if (Object.keys(report).length) {
    await mkdir(REPORT_DIR, { recursive: true });
    const reportPath = join(REPORT_DIR, `audit_report_${timestamp}.md`);
    const mdContent = buildMarkdownReport(report, plan, timestamp);
    await writeFile(reportPath, mdContent, "utf-8");
    await log("REPORT", `보고서 저장: audit_report_${timestamp}.md`);
  }

  return report;
}

// ─── 메인 워크플로우 ──────────────────────────────────────────────────────────

async function runWorkflow(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(
    AUDIT_LOG,
    `=== 워크플로우 시작: ${new Date().toISOString()} ===\n`,
    "utf-8"
  );

  console.log("\n" + "█".repeat(60));
  console.log("  코드베이스 감사 에이전트 워크플로우");
  console.log("█".repeat(60) + "\n");

  // 1단계: 지식 수집
  console.log("\n[1/5] 지식 수집 (GATHER)");
  console.log("-".repeat(40));
  const sessionId = await gatherKnowledge();

  // 2단계: 계획 수립
  console.log("\n[2/5] 계획 수립 (PLAN)");
  console.log("-".repeat(40));
  const [plan, sessionAfterPlan] = await createPlan(sessionId);

  console.log(`\n  목표: ${plan.goal}`);
  console.log(`  범위: ${plan.scope}`);
  console.log("  단계:");
  for (const step of plan.steps as Step[]) {
    const deps = step.depends_on.length ? ` (의존: ${step.depends_on})` : "";
    console.log(`    ${step.id}. [${step.phase}] ${step.action.slice(0, 60)}${deps}`);
  }

  // 3단계: 실행
  console.log("\n[3/5] 계획 실행 (EXECUTE)");
  console.log("-".repeat(40));
  const [executionResult, sessionAfterExec] = await executePlan(plan, sessionAfterPlan);

  // 4단계: 결과 점검
  console.log("\n[4/5] 결과 점검 (VERIFY)");
  console.log("-".repeat(40));
  const [finalResult, sessionAfterVerify] = await verifyWithIteration(
    plan, executionResult, sessionAfterExec, 2
  );

  // 5단계: 보고
  console.log("\n[5/5] 보고서 생성 (REPORT)");
  console.log("-".repeat(40));
  const report = await generateReport(plan, finalResult, sessionAfterVerify);

  // 최종 요약 출력
  console.log("\n" + "█".repeat(60));
  console.log("  워크플로우 완료");
  console.log("█".repeat(60));
  console.log(`\n  심각도: ${(report.severity as string ?? "?").toUpperCase()}`);
  console.log(`  발견 사항: ${(report.findings as unknown[])?.length ?? 0}개`);
  console.log(`  권장 조치: ${(report.recommendations as unknown[])?.length ?? 0}개`);
  console.log(`  보고서 위치: ${REPORT_DIR}/`);
  console.log(`  감사 로그: workflow_audit.log\n`);
}

runWorkflow().catch((e) => {
  console.error("[ERROR] 워크플로우 실패:", e);
  process.exit(1);
});
