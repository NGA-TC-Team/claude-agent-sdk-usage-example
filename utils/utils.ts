/**
 * 공통 유틸리티 함수 모음.
 * 모든 예제에서 import해 사용한다.
 */

type AnyMessage = Record<string, unknown>;

/** 비용을 보기 좋은 문자열로 반환한다. undefined면 'N/A'. */
export function formatCost(usd: number | undefined): string {
  if (usd === undefined || usd === null) return "N/A";
  return `$${usd.toFixed(4)}`;
}

/**
 * SystemMessage(init) 또는 ResultMessage에서 session_id를 추출한다.
 * 세션을 resume할 때 이 값을 보관해 두면 된다.
 */
export function extractSessionId(message: AnyMessage): string | undefined {
  if (message.type === "system" && message.subtype === "init") {
    return (message as { session_id?: string }).session_id;
  }
  if (message.type === "result") {
    return (message as { session_id?: string }).session_id;
  }
  return undefined;
}

/**
 * AssistantMessage의 content 블록을 타입별로 출력한다.
 * - text: 응답 텍스트
 * - thinking: 확장 사고(Extended Thinking) 내용
 * - tool_use: Claude가 호출한 도구 이름과 입력값
 */
export function printMessage(message: AnyMessage): void {
  if (message.type !== "assistant") return;

  const msg = message.message as { content: AnyMessage[] };
  for (const block of msg.content) {
    if (block.type === "text") {
      process.stdout.write((block.text as string) + "\n");
    } else if (block.type === "thinking") {
      // Extended Thinking이 활성화된 경우에만 나타난다
      const preview = ((block.thinking as string) ?? "").slice(0, 120);
      console.log(`\n[thinking] ${preview}...\n`);
    } else if (block.type === "tool_use") {
      console.log(`\n[tool] ${block.name}(${JSON.stringify(block.input)})`);
    }
  }
}

/** ResultMessage의 완료 상태, 비용, 세션 ID를 한 줄로 출력한다. */
export function printResult(message: AnyMessage): void {
  if (message.type !== "result") return;

  const cost = formatCost(message.total_cost_usd as number | undefined);
  console.log(
    `[done: ${message.subtype} | turns: ${message.num_turns} | cost: ${cost} | session: ${message.session_id}]`
  );
}
