/**
 * keep-history/history.ts — 대화 히스토리 관리 예제 (TypeScript)
 *
 * 세 가지 패턴을 보여준다:
 * 1. continue: true로 직전 세션 자동 이어받기
 * 2. session_id 캡처 후 resume으로 특정 세션 재개
 * 3. 세션 목록 조회 및 관리
 */

import {
  query,
  listSessions,
  renameSession,
  tagSession,
} from "@anthropic-ai/claude-agent-sdk";
import { extractSessionId, printResult } from "../utils/utils.ts";

type AnyMessage = Record<string, unknown>;

function printText(message: AnyMessage): void {
  if (message.type !== "assistant") return;
  const content = (message.message as { content: AnyMessage[] }).content;
  for (const block of content) {
    if (block.type === "text") {
      console.log(block.text as string);
    }
  }
}

async function continueConversation(): Promise<void> {
  /**
   * 패턴 1: continue: true 패턴.
   * 첫 번째 query 후 두 번째 query에 continue: true를 설정하면
   * SDK가 디스크에서 가장 최근 세션을 찾아 이어받는다.
   * session_id를 직접 추적할 필요가 없다.
   */
  console.log("=".repeat(50));
  console.log("패턴 1: continue: true (자동 세션 이어받기)");
  console.log("=".repeat(50));

  // 첫 번째 대화: 새 세션 시작
  for await (const message of query({
    prompt: "Python에서 데코레이터란 무엇인가요?",
    options: {
      systemPrompt: "You are a helpful assistant. Respond in Korean, concisely.",
    },
  })) {
    const msg = message as AnyMessage;
    printText(msg);
    if (msg.type === "result") printResult(msg);
  }

  console.log("\n[두 번째 질문 — continue: true로 앞 맥락 유지]\n");

  // 두 번째 대화: continue: true로 직전 세션 이어받기
  // "그것"이 앞 대화의 데코레이터를 지칭함
  for await (const message of query({
    prompt: "그것을 실제로 사용하는 예시 코드를 보여주세요.",
    options: {
      continue: true,
    },
  })) {
    const msg = message as AnyMessage;
    printText(msg);
    if (msg.type === "result") printResult(msg);
  }
}

async function manualSessionResume(): Promise<string | undefined> {
  /**
   * 패턴 2: session_id 캡처 후 resume.
   * ResultMessage에서 session_id를 저장하고
   * 이후 query에서 resume 옵션으로 해당 세션을 재개한다.
   * 프로세스 재시작 후 특정 세션으로 돌아가야 할 때 사용한다.
   */
  console.log("\n" + "=".repeat(50));
  console.log("패턴 2: session_id 캡처 후 resume");
  console.log("=".repeat(50));

  let sessionId: string | undefined;

  // 첫 번째 대화
  for await (const message of query({
    prompt: "대한민국의 수도는 어디인가요?",
    options: {
      systemPrompt: "You are a helpful assistant. Respond in Korean.",
    },
  })) {
    const msg = message as AnyMessage;
    printText(msg);

    if (msg.type === "result") {
      // ResultMessage에 session_id가 항상 포함된다
      sessionId = extractSessionId(msg);
      printResult(msg);
    }
  }

  if (!sessionId) return undefined;

  console.log(`\n[저장된 session_id: ${sessionId}]`);
  console.log("[이 ID를 Redis/DB에 저장해두면 프로세스 재시작 후에도 재개 가능]\n");

  // 두 번째 대화: 앞 세션 이어받기
  for await (const message of query({
    prompt: "그 도시의 현재 인구는 얼마인가요?", // "그 도시" = 서울
    options: {
      resume: sessionId,
    },
  })) {
    const msg = message as AnyMessage;
    printText(msg);
    if (msg.type === "result") printResult(msg);
  }

  return sessionId;
}

async function sessionManagement(sessionId: string | undefined): Promise<void> {
  /**
   * 패턴 3: 세션 목록 조회, 이름 변경, 태그 설정.
   */
  console.log("\n" + "=".repeat(50));
  console.log("패턴 3: 세션 관리");
  console.log("=".repeat(50));

  // 최근 5개 세션 조회
  const sessions = await listSessions({ limit: 5 });
  console.log(`최근 세션 ${sessions.length}개:`);
  for (const s of sessions) {
    console.log(`  ${s.session_id.slice(0, 16)}... | ${s.summary ?? "(제목 없음)"}`);
  }

  if (sessionId) {
    // 세션에 사람이 읽기 쉬운 제목 설정
    await renameSession(sessionId, "서울 인구 질문 세션");
    console.log(`\n세션 이름 변경 완료: ${sessionId.slice(0, 16)}...`);

    // 세션에 태그 추가 (검색/분류용)
    await tagSession(sessionId, "geography");
    console.log("태그 추가 완료: geography");
  }
}

async function main(): Promise<void> {
  await continueConversation();
  const sessionId = await manualSessionResume();
  await sessionManagement(sessionId);
}

main().catch(console.error);
