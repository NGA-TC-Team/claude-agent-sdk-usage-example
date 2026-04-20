"""
공통 유틸리티 함수 모음.
모든 예제에서 import해 사용한다.
"""

from __future__ import annotations

from typing import Any

from claude_agent_sdk import AssistantMessage, ResultMessage, SystemMessage
from claude_agent_sdk.types import TextBlock, ThinkingBlock, ToolUseBlock


def format_cost(usd: float | None) -> str:
    """비용을 보기 좋은 문자열로 반환한다. None이면 'N/A'."""
    if usd is None:
        return "N/A"
    return f"${usd:.4f}"


def extract_session_id(message: Any) -> str | None:
    """
    SystemMessage(init) 또는 ResultMessage에서 session_id를 추출한다.
    세션을 resume할 때 이 값을 보관해 두면 된다.
    """
    if isinstance(message, SystemMessage) and message.subtype == "init":
        return message.data.get("session_id")
    if isinstance(message, ResultMessage):
        return message.session_id
    return None


def print_message(message: Any) -> None:
    """
    AssistantMessage의 content 블록을 타입별로 출력한다.
    - TextBlock: 응답 텍스트
    - ThinkingBlock: 확장 사고(Extended Thinking) 내용
    - ToolUseBlock: Claude가 호출한 도구 이름과 입력값
    """
    if not isinstance(message, AssistantMessage):
        return

    for block in message.content:
        if isinstance(block, TextBlock):
            print(block.text, end="", flush=True)
        elif isinstance(block, ThinkingBlock):
            # Extended Thinking이 활성화된 경우에만 나타난다
            print(f"\n[thinking] {block.thinking[:120]}...\n")
        elif isinstance(block, ToolUseBlock):
            print(f"\n[tool] {block.name}({block.input})")

    # AssistantMessage는 여러 블록이 이어질 수 있으므로 마지막에 줄바꿈
    print()


def print_result(message: Any) -> None:
    """ResultMessage의 완료 상태, 비용, 세션 ID를 한 줄로 출력한다."""
    if not isinstance(message, ResultMessage):
        return

    cost = format_cost(message.total_cost_usd)
    print(
        f"[done: {message.subtype} | turns: {message.num_turns} "
        f"| cost: {cost} | session: {message.session_id}]"
    )
