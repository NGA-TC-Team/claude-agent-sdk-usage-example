/**
 * just-chat/chat.ts — 기본 채팅 예제 (TypeScript)
 *
 * 세 가지 패턴을 보여준다:
 * 1. 최소 예제: prompt만 전달
 * 2. 시스템 프롬프트로 역할 지정
 * 3. 다양한 메시지 블록 타입 처리
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { printMessage, printResult } from "../utils/utils.ts";

type AnyMessage = Record<string, unknown>;

async function simpleChat(): Promise<void> {
  console.log("=".repeat(50));
  console.log("패턴 1: 단순 채팅");
  console.log("=".repeat(50));

  for await (const message of query({
    prompt: "안녕하세요! 한 문장으로 자기소개 해주세요.",
  })) {
    const msg = message as AnyMessage;

    if (msg.type === "assistant") {
      const content = (msg.message as { content: AnyMessage[] }).content;
      for (const block of content) {
        if (block.type === "text") {
          console.log(block.text as string);
        }
      }
    } else if (msg.type === "result") {
      printResult(msg);
    }
  }
}

async function chatWithSystemPrompt(): Promise<void> {
  console.log("\n" + "=".repeat(50));
  console.log("패턴 2: 시스템 프롬프트 사용");
  console.log("=".repeat(50));

  for await (const message of query({
    prompt: "리스트 컴프리헨션과 map() 중 어느 것을 써야 하나요?",
    options: {
      // Claude를 Python 전문가로 설정
      systemPrompt:
        "당신은 경험 많은 Python 시니어 개발자입니다. " +
        "답변은 항상 한국어로, 간결하고 실용적으로 제공하세요. " +
        "코드 예시가 필요하면 반드시 포함하세요.",
    },
  })) {
    const msg = message as AnyMessage;
    printMessage(msg);
    if (msg.type === "result") printResult(msg);
  }
}

async function multiStyleChat(): Promise<void> {
  /**
   * 패턴 3: 다양한 메시지 타입 직접 처리.
   * AssistantMessage의 content 블록을 직접 순회해
   * 각 블록 타입을 구분해서 출력한다.
   */
  console.log("\n" + "=".repeat(50));
  console.log("패턴 3: 메시지 블록 타입 직접 처리");
  console.log("=".repeat(50));

  for await (const message of query({
    prompt: "Python의 GIL이 무엇인지 세 줄로 설명해주세요.",
    options: {
      systemPrompt: "You are a helpful assistant. Respond in Korean.",
    },
  })) {
    const msg = message as AnyMessage;

    if (msg.type === "assistant") {
      const content = (msg.message as { content: AnyMessage[] }).content;
      console.log(`[AssistantMessage 수신 - 블록 수: ${content.length}]`);

      content.forEach((block, i) => {
        if (block.type === "text") {
          console.log(`  [블록 ${i}] TextBlock:`);
          console.log(`  ${block.text as string}`);
        } else if (block.type === "thinking") {
          // Extended Thinking 사용 시에만 나타난다
          const preview = ((block.thinking as string) ?? "").slice(0, 80);
          console.log(`  [블록 ${i}] ThinkingBlock: ${preview}...`);
        } else if (block.type === "tool_use") {
          // 이 예제에서는 도구를 사용하지 않지만,
          // 도구 허용 시 이 블록이 나타날 수 있다
          console.log(
            `  [블록 ${i}] ToolUseBlock: ${block.name as string}(${JSON.stringify(block.input)})`
          );
        }
      });
    } else if (msg.type === "result") {
      printResult(msg);
    }
  }
}

async function main(): Promise<void> {
  await simpleChat();
  await chatWithSystemPrompt();
  await multiStyleChat();
}

main().catch(console.error);
