"""
just-chat/chat.py — 기본 채팅 예제 (Python)

세 가지 패턴을 보여준다:
1. 최소 예제: prompt만 전달
2. 시스템 프롬프트로 역할 지정
3. 다양한 메시지 블록 타입 처리
"""

import asyncio
import sys
from pathlib import Path

# utils 모듈 경로 추가
sys.path.insert(0, str(Path(__file__).parent.parent))

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ResultMessage, query
from claude_agent_sdk.types import TextBlock, ToolUseBlock

from utils.utils import print_message, print_result


async def simple_chat() -> None:
    """
    패턴 1: 최소 예제.
    prompt 하나만 전달하고 텍스트 응답을 출력한다.
    """
    print("=" * 50)
    print("패턴 1: 단순 채팅")
    print("=" * 50)

    async for message in query(prompt="안녕하세요! 한 문장으로 자기소개 해주세요."):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(block.text)
        elif isinstance(message, ResultMessage):
            print_result(message)


async def chat_with_system_prompt() -> None:
    """
    패턴 2: 시스템 프롬프트로 Claude 역할 지정.
    system_prompt는 대화 내내 유지되며 Claude의 행동 방식을 결정한다.
    """
    print("\n" + "=" * 50)
    print("패턴 2: 시스템 프롬프트 사용")
    print("=" * 50)

    options = ClaudeAgentOptions(
        # Claude를 Python 전문가로 설정
        system_prompt=(
            "당신은 경험 많은 Python 시니어 개발자입니다. "
            "답변은 항상 한국어로, 간결하고 실용적으로 제공하세요. "
            "코드 예시가 필요하면 반드시 포함하세요."
        ),
    )

    async for message in query(
        prompt="리스트 컴프리헨션과 map() 중 어느 것을 써야 하나요?",
        options=options,
    ):
        print_message(message)
        if isinstance(message, ResultMessage):
            print_result(message)


async def multi_style_chat() -> None:
    """
    패턴 3: 다양한 메시지 타입 직접 처리.
    AssistantMessage의 content 블록을 직접 순회해
    TextBlock과 ToolUseBlock을 구분해서 출력한다.
    도구를 사용하지 않는 순수 채팅에서도 블록 처리 방식을 익히기 위한 예제다.
    """
    print("\n" + "=" * 50)
    print("패턴 3: 메시지 블록 타입 직접 처리")
    print("=" * 50)

    options = ClaudeAgentOptions(
        system_prompt="You are a helpful assistant. Respond in Korean.",
    )

    async for message in query(
        prompt="Python의 GIL이 무엇인지 세 줄로 설명해주세요.",
        options=options,
    ):
        if isinstance(message, AssistantMessage):
            print(f"[AssistantMessage 수신 - 블록 수: {len(message.content)}]")
            for i, block in enumerate(message.content):
                if isinstance(block, TextBlock):
                    print(f"  [블록 {i}] TextBlock:")
                    print(f"  {block.text}")
                elif isinstance(block, ToolUseBlock):
                    # 이 예제에서는 도구를 사용하지 않지만,
                    # 도구 허용 시 이 블록이 나타날 수 있다
                    print(f"  [블록 {i}] ToolUseBlock: {block.name}({block.input})")

        elif isinstance(message, ResultMessage):
            print_result(message)


async def main() -> None:
    await simple_chat()
    await chat_with_system_prompt()
    await multi_style_chat()


if __name__ == "__main__":
    asyncio.run(main())
