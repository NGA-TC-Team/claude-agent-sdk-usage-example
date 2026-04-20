"""
with-streaming/streaming.py — 스트리밍 예제 (Python)

두 가지 패턴을 보여준다:
1. 실시간 스트리밍: StreamEvent에서 텍스트 청크를 추출해 즉시 출력
2. 블로킹 vs 스트리밍 비교: 두 방식의 체감 응답 속도 차이
"""

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    StreamEvent,
    query,
)
from claude_agent_sdk.types import TextBlock

from utils.utils import print_result


async def stream_response() -> None:
    """
    패턴 1: StreamEvent로 텍스트 실시간 출력.

    include_partial_messages=True 설정 시 StreamEvent가 yield된다.
    StreamEvent.event 딕셔너리에서 text_delta를 추출해 즉시 출력한다.

    출력 구조:
    - StreamEvent: 텍스트가 생성될 때마다 도착 (부분 텍스트)
    - AssistantMessage: 완성된 전체 메시지 (스트리밍 완료 후)
    - ResultMessage: 완료 신호 + 비용 정보
    """
    print("=" * 50)
    print("패턴 1: 실시간 스트리밍")
    print("=" * 50)
    print("[스트리밍 시작 →]\n")

    options = ClaudeAgentOptions(
        # 이 옵션을 True로 설정해야 StreamEvent가 yield된다
        include_partial_messages=True,
    )

    async for message in query(
        prompt=(
            "Python의 asyncio 이벤트 루프가 어떻게 동작하는지 "
            "단계별로 자세히 설명해주세요."
        ),
        options=options,
    ):
        if isinstance(message, StreamEvent):
            event = message.event
            # content_block_delta 이벤트에 실제 텍스트 청크가 담긴다
            if event.get("type") == "content_block_delta":
                delta = event.get("delta", {})
                if delta.get("type") == "text_delta":
                    # flush=True: 버퍼 없이 즉시 출력
                    print(delta["text"], end="", flush=True)
                elif delta.get("type") == "thinking_delta":
                    # Extended Thinking 활성화 시 사고 과정도 스트리밍됨
                    pass

        elif isinstance(message, AssistantMessage):
            # StreamEvent가 모두 도착한 뒤 완성된 메시지가 온다
            # 이미 스트리밍으로 출력했으므로 여기서는 줄바꿈만
            print("\n")

        elif isinstance(message, ResultMessage):
            print_result(message)


async def compare_blocking_vs_streaming() -> None:
    """
    패턴 2: 블로킹 방식과 스트리밍 방식의 체감 속도 비교.

    동일한 프롬프트로 두 방식을 실행하고 첫 출력까지의 시간(TTFB)을 측정한다.
    실제 API 처리 시간은 같지만 사용자 체감 속도는 크게 다르다.
    """
    prompt = "Python 제너레이터의 장점을 세 가지만 설명해주세요."

    # --- 블로킹 방식 ---
    print("\n" + "=" * 50)
    print("패턴 2a: 블로킹 방식 (스트리밍 없음)")
    print("=" * 50)

    start = time.time()
    first_output_time: float | None = None

    async for message in query(
        prompt=prompt,
        options=ClaudeAgentOptions(include_partial_messages=False),
    ):
        if isinstance(message, AssistantMessage):
            elapsed = time.time() - start
            if first_output_time is None:
                first_output_time = elapsed
                print(f"[첫 출력까지: {elapsed:.2f}초]")
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(block.text)

    print(f"[총 소요 시간: {time.time() - start:.2f}초]")

    # --- 스트리밍 방식 ---
    print("\n" + "=" * 50)
    print("패턴 2b: 스트리밍 방식")
    print("=" * 50)

    start = time.time()
    first_output_time = None

    async for message in query(
        prompt=prompt,
        options=ClaudeAgentOptions(include_partial_messages=True),
    ):
        if isinstance(message, StreamEvent):
            event = message.event
            if (
                event.get("type") == "content_block_delta"
                and event.get("delta", {}).get("type") == "text_delta"
            ):
                elapsed = time.time() - start
                if first_output_time is None:
                    first_output_time = elapsed
                    print(f"[첫 출력까지: {elapsed:.2f}초]")
                print(event["delta"]["text"], end="", flush=True)

        elif isinstance(message, AssistantMessage):
            print()

    print(f"\n[총 소요 시간: {time.time() - start:.2f}초]")
    print("\n[결론: 총 시간은 비슷하지만 스트리밍 방식이 첫 출력이 훨씬 빠름]")


async def main() -> None:
    await stream_response()
    await compare_blocking_vs_streaming()


if __name__ == "__main__":
    asyncio.run(main())
