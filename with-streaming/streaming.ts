/**
 * with-streaming/streaming.ts — 스트리밍 예제 (TypeScript)
 *
 * 두 가지 패턴을 보여준다:
 * 1. 실시간 스트리밍: StreamEvent에서 텍스트 청크를 추출해 즉시 출력
 * 2. 블로킹 vs 스트리밍 비교: 첫 출력까지의 시간(TTFB) 측정
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { printResult } from "../utils/utils.ts";

type AnyMessage = Record<string, unknown>;

async function streamResponse(): Promise<void> {
  /**
   * 패턴 1: StreamEvent로 텍스트 실시간 출력.
   *
   * includePartialMessages: true 설정 시 StreamEvent가 yield된다.
   * event.type === "content_block_delta" 이고
   * event.delta.type === "text_delta" 인 경우 텍스트 청크가 담겨 있다.
   *
   * 출력 순서:
   * - StreamEvent: 텍스트가 생성될 때마다 도착 (부분 텍스트)
   * - AssistantMessage: 완성된 전체 메시지 (스트리밍 완료 후)
   * - ResultMessage: 완료 신호 + 비용 정보
   */
  console.log("=".repeat(50));
  console.log("패턴 1: 실시간 스트리밍");
  console.log("=".repeat(50));
  console.log("[스트리밍 시작 →]\n");

  for await (const message of query({
    prompt:
      "Python의 asyncio 이벤트 루프가 어떻게 동작하는지 " +
      "단계별로 자세히 설명해주세요.",
    options: {
      // 이 옵션을 true로 설정해야 StreamEvent가 yield된다
      includePartialMessages: true,
    },
  })) {
    const msg = message as AnyMessage;

    if (msg.type === "stream_event") {
      const event = msg.event as AnyMessage;
      // content_block_delta 이벤트에 실제 텍스트 청크가 담긴다
      if (event.type === "content_block_delta") {
        const delta = event.delta as AnyMessage;
        if (delta.type === "text_delta") {
          // flush 없이도 Node.js stdout은 즉시 출력된다
          process.stdout.write(delta.text as string);
        }
        // thinking_delta: Extended Thinking 활성화 시 사고 과정 스트리밍
      }
    } else if (msg.type === "assistant") {
      // StreamEvent가 모두 도착한 뒤 완성된 메시지가 온다
      process.stdout.write("\n\n");
    } else if (msg.type === "result") {
      printResult(msg);
    }
  }
}

async function compareBlockingVsStreaming(): Promise<void> {
  /**
   * 패턴 2: 블로킹 방식과 스트리밍 방식의 체감 속도 비교.
   * 동일한 프롬프트로 두 방식을 실행하고 TTFB를 측정한다.
   */
  const prompt = "Python 제너레이터의 장점을 세 가지만 설명해주세요.";

  // --- 블로킹 방식 ---
  console.log("\n" + "=".repeat(50));
  console.log("패턴 2a: 블로킹 방식 (스트리밍 없음)");
  console.log("=".repeat(50));

  let start = Date.now();
  let firstOutputTime: number | null = null;

  for await (const message of query({
    prompt,
    options: { includePartialMessages: false },
  })) {
    const msg = message as AnyMessage;

    if (msg.type === "assistant") {
      const elapsed = (Date.now() - start) / 1000;
      if (firstOutputTime === null) {
        firstOutputTime = elapsed;
        console.log(`[첫 출력까지: ${elapsed.toFixed(2)}초]`);
      }
      const content = (msg.message as { content: AnyMessage[] }).content;
      for (const block of content) {
        if (block.type === "text") console.log(block.text as string);
      }
    }
  }
  console.log(`[총 소요 시간: ${((Date.now() - start) / 1000).toFixed(2)}초]`);

  // --- 스트리밍 방식 ---
  console.log("\n" + "=".repeat(50));
  console.log("패턴 2b: 스트리밍 방식");
  console.log("=".repeat(50));

  start = Date.now();
  firstOutputTime = null;

  for await (const message of query({
    prompt,
    options: { includePartialMessages: true },
  })) {
    const msg = message as AnyMessage;

    if (msg.type === "stream_event") {
      const event = msg.event as AnyMessage;
      if (
        event.type === "content_block_delta" &&
        (event.delta as AnyMessage)?.type === "text_delta"
      ) {
        const elapsed = (Date.now() - start) / 1000;
        if (firstOutputTime === null) {
          firstOutputTime = elapsed;
          console.log(`[첫 출력까지: ${elapsed.toFixed(2)}초]`);
        }
        process.stdout.write((event.delta as AnyMessage).text as string);
      }
    } else if (msg.type === "assistant") {
      process.stdout.write("\n");
    }
  }

  console.log(`\n[총 소요 시간: ${((Date.now() - start) / 1000).toFixed(2)}초]`);
  console.log("\n[결론: 총 시간은 비슷하지만 스트리밍 방식이 첫 출력이 훨씬 빠름]");
}

async function main(): Promise<void> {
  await streamResponse();
  await compareBlockingVsStreaming();
}

main().catch(console.error);
