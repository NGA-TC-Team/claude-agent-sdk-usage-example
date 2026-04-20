/**
 * using-tools/tools.ts — 도구 활용 예제 (TypeScript)
 *
 * 세 가지 패턴을 보여준다:
 * 1. 읽기 전용 에이전트: Read, Glob, Grep만 허용
 * 2. 훅 로깅: PostToolUse 훅으로 도구 실행 감사 로그 기록
 * 3. acceptEdits 모드: 파일 편집 자동 승인
 */

import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFile, writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { printResult } from "../utils/utils.ts";

type AnyMessage = Record<string, unknown>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

function printText(message: AnyMessage): void {
  if (message.type !== "assistant") return;
  const content = (message.message as { content: AnyMessage[] }).content;
  for (const block of content) {
    if (block.type === "text") {
      process.stdout.write((block.text as string) + "\n");
    }
  }
}

async function readonlyAgent(): Promise<void> {
  /**
   * 패턴 1: 읽기 전용 에이전트.
   * Read, Glob, Grep만 허용해 파일 수정 없이 코드베이스를 분석한다.
   * CI/CD 코드 리뷰나 분석 작업에 적합하다.
   */
  console.log("=".repeat(50));
  console.log("패턴 1: 읽기 전용 에이전트");
  console.log("=".repeat(50));

  for await (const message of query({
    prompt:
      "이 프로젝트의 Python 파일 목록을 찾아서 " +
      "각 파일이 어떤 역할을 하는지 한 줄씩 설명해주세요.",
    options: {
      allowedTools: ["Read", "Glob", "Grep"],
      // cwd로 작업 디렉토리를 프로젝트 루트로 지정
      cwd: projectRoot,
    },
  })) {
    const msg = message as AnyMessage;
    printText(msg);
    if (msg.type === "result") printResult(msg);
  }
}

async function hookLogging(): Promise<void> {
  /**
   * 패턴 2: PostToolUse 훅으로 도구 실행 감사 로그 기록.
   * 모든 도구 실행 후 audit.log에 기록한다.
   * 보안 감사나 디버깅에 유용하다.
   */
  console.log("\n" + "=".repeat(50));
  console.log("패턴 2: 훅으로 도구 실행 로깅");
  console.log("=".repeat(50));

  const logPath = join(__dirname, "audit.log");

  const logToolUse: HookCallback = async (input) => {
    /**
     * PostToolUse 훅 콜백.
     * 도구명과 주요 인자를 로그에 기록한다.
     */
    const data = input as Record<string, unknown>;
    const toolName = (data.tool_name as string) ?? "unknown";
    const toolInput = (data.tool_input as Record<string, string>) ?? {};

    let detail = "";
    if (["Read", "Write", "Edit"].includes(toolName)) {
      detail = toolInput.file_path ?? "";
    } else if (toolName === "Bash") {
      detail = (toolInput.command ?? "").slice(0, 60);
    }

    await appendFile(
      logPath,
      `${new Date().toISOString()} | ${toolName} | ${detail}\n`,
      "utf-8"
    );

    // 빈 객체 반환 = 도구 실행 그대로 진행
    return {};
  };

  for await (const message of query({
    prompt: "utils/utils.py 파일을 읽고 어떤 함수들이 있는지 알려주세요.",
    options: {
      allowedTools: ["Read", "Glob", "Grep"],
      hooks: {
        // matcher를 생략하면 모든 도구에 훅이 적용된다
        PostToolUse: [{ hooks: [logToolUse] }],
      },
      cwd: projectRoot,
    },
  })) {
    const msg = message as AnyMessage;
    printText(msg);
    if (msg.type === "result") printResult(msg);
  }

  try {
    const log = await readFile(logPath, "utf-8");
    console.log(`\n[감사 로그 (audit.log):]`);
    console.log(log);
  } catch {
    // 로그 파일이 없으면 무시
  }
}

async function editAgent(): Promise<void> {
  /**
   * 패턴 3: acceptEdits 모드 — 파일 편집 자동 승인.
   * Edit, Write 도구 사용 시 매번 승인 요청 없이 자동으로 실행한다.
   *
   * 주의: 이 예제는 /tmp 임시 파일을 사용해 실제 프로젝트 파일을 수정하지 않는다.
   */
  console.log("\n" + "=".repeat(50));
  console.log("패턴 3: acceptEdits 모드 (파일 편집 자동 승인)");
  console.log("=".repeat(50));

  const tmpPath = join(tmpdir(), `test-${Date.now()}.py`);
  await writeFile(tmpPath, "# TODO: fix this\ndef add(a, b):\n    return a - b  # 버그!\n", "utf-8");
  console.log(`[테스트 파일 생성: ${tmpPath}]`);

  for await (const message of query({
    prompt: `${tmpPath} 파일의 버그를 찾아서 수정해주세요.`,
    options: {
      allowedTools: ["Read", "Edit"],
      // acceptEdits: Edit/Write 도구를 사용자 확인 없이 자동 승인
      permissionMode: "acceptEdits",
    },
  })) {
    const msg = message as AnyMessage;
    printText(msg);
    if (msg.type === "result") printResult(msg);
  }

  // 수정 결과 확인
  const fixed = await readFile(tmpPath, "utf-8");
  console.log(`\n[수정된 파일 내용:]\n${fixed}`);
  await unlink(tmpPath);
}

async function main(): Promise<void> {
  await readonlyAgent();
  await hookLogging();
  await editAgent();
}

main().catch(console.error);
