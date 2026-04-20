/**
 * with-mcp/mcp.ts — MCP 서버 연동 예제 (TypeScript)
 *
 * 두 가지 패턴을 보여준다:
 * 1. filesystem MCP 서버 (stdio): 로컬 파일 탐색
 * 2. HTTP MCP 서버: Claude Code 공식 문서 서버 연결
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { dirname, join } from "node:path";
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

async function filesystemMcp(): Promise<void> {
  /**
   * 패턴 1: filesystem MCP 서버 (stdio transport).
   * npx로 로컬에 서버를 실행하고 파일 시스템 도구를 사용한다.
   *
   * 사전 조건: Node.js 설치 필요.
   * 서버가 없으면 npx가 자동으로 설치한다.
   */
  console.log("=".repeat(50));
  console.log("패턴 1: filesystem MCP 서버 (stdio)");
  console.log("=".repeat(50));

  for await (const message of query({
    prompt:
      `${projectRoot} 디렉토리의 구조를 탐색하고 ` +
      "주요 파일들을 나열해주세요.",
    options: {
      mcpServers: {
        filesystem: {
          // stdio transport: command로 로컬 프로세스를 실행
          command: "npx",
          args: [
            "-y",
            "@modelcontextprotocol/server-filesystem",
            projectRoot, // 접근 허용할 디렉토리
          ],
        },
      },
      // mcp__<서버명>__* 으로 해당 서버의 모든 도구를 허용
      allowedTools: ["mcp__filesystem__*"],
    },
  })) {
    const msg = message as AnyMessage;

    // 연결 상태 확인: init SystemMessage에서 서버 상태를 볼 수 있다
    if (msg.type === "system" && msg.subtype === "init") {
      const servers = (msg.mcp_servers as AnyMessage[]) ?? [];
      for (const s of servers) {
        console.log(`[MCP 서버] ${s.name}: ${s.status}`);
      }
    } else {
      printText(msg);
    }

    if (msg.type === "result") printResult(msg);
  }
}

async function httpMcp(): Promise<void> {
  /**
   * 패턴 2: HTTP MCP 서버 (원격 서버).
   * Claude Code 공식 문서 MCP 서버에 연결해 문서를 조회한다.
   * 별도 설치 없이 URL만으로 연결할 수 있다.
   */
  console.log("\n" + "=".repeat(50));
  console.log("패턴 2: HTTP MCP 서버 (원격)");
  console.log("=".repeat(50));

  for await (const message of query({
    prompt:
      "Claude Agent SDK의 sessions 기능에 대해 " +
      "문서를 참조해서 설명해주세요.",
    options: {
      mcpServers: {
        "claude-code-docs": {
          // HTTP transport: URL로 원격 서버에 연결
          type: "http",
          url: "https://code.claude.com/docs/mcp",
        },
      },
      allowedTools: ["mcp__claude-code-docs__*"],
    },
  })) {
    const msg = message as AnyMessage;

    if (msg.type === "system" && msg.subtype === "init") {
      const servers = (msg.mcp_servers as AnyMessage[]) ?? [];
      for (const s of servers) {
        if (s.status !== "connected") {
          console.warn(`[경고] MCP 서버 '${s.name}' 연결 실패: ${s.status}`);
        } else {
          console.log(`[MCP 서버] ${s.name}: ${s.status}`);
        }
      }
    } else {
      printText(msg);
    }

    if (msg.type === "result") {
      if (msg.subtype === "error_during_execution") {
        console.error("[오류] 실행 중 오류 발생");
      }
      printResult(msg);
    }
  }
}

async function main(): Promise<void> {
  await filesystemMcp();
  await httpMcp();
}

main().catch(console.error);
