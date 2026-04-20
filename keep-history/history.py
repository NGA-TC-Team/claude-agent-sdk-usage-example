"""
keep-history/history.py — 대화 히스토리 관리 예제 (Python)

세 가지 패턴을 보여준다:
1. ClaudeSDKClient: 인메모리 세션 자동 유지
2. session_id 캡처 후 resume으로 특정 세션 재개
3. 세션 목록 조회·이름 변경·태그 설정
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    list_sessions,
    query,
    rename_session,
    tag_session,
)
from claude_agent_sdk.types import TextBlock

from utils.utils import print_result


def _print_text(message: AssistantMessage) -> None:
    """AssistantMessage에서 텍스트만 추출해 출력한다."""
    for block in message.content:
        if isinstance(block, TextBlock):
            print(block.text)


async def in_memory_client() -> None:
    """
    패턴 1: ClaudeSDKClient 사용.
    같은 client 인스턴스로 여러 질문을 보내면 SDK가 세션을 내부적으로 유지한다.
    session_id를 직접 다룰 필요가 없다.
    """
    print("=" * 50)
    print("패턴 1: ClaudeSDKClient (인메모리 세션 유지)")
    print("=" * 50)

    options = ClaudeAgentOptions(
        system_prompt="You are a helpful assistant. Respond in Korean, concisely.",
    )

    async with ClaudeSDKClient(options=options) as client:
        # 첫 번째 질문
        await client.query("Python에서 데코레이터란 무엇인가요?")
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                _print_text(message)
            elif isinstance(message, ResultMessage):
                print_result(message)

        print("\n[두 번째 질문 — 앞 맥락 유지됨]\n")

        # 두 번째 질문: "그것"이 앞에서 설명한 데코레이터를 지칭함
        await client.query("그것을 실제로 사용하는 예시 코드를 보여주세요.")
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                _print_text(message)
            elif isinstance(message, ResultMessage):
                print_result(message)


async def manual_session_resume() -> str | None:
    """
    패턴 2: session_id 캡처 후 resume.
    첫 번째 query에서 session_id를 저장하고,
    두 번째 query에서 resume=session_id로 이어받는다.
    프로세스 재시작 후 특정 세션으로 돌아가야 할 때 사용한다.
    """
    print("\n" + "=" * 50)
    print("패턴 2: session_id 캡처 후 resume")
    print("=" * 50)

    session_id: str | None = None

    # 첫 번째 대화
    async for message in query(
        prompt="대한민국의 수도는 어디인가요?",
        options=ClaudeAgentOptions(
            system_prompt="You are a helpful assistant. Respond in Korean.",
        ),
    ):
        if isinstance(message, AssistantMessage):
            _print_text(message)
        elif isinstance(message, ResultMessage):
            # ResultMessage에 session_id가 항상 포함된다
            session_id = message.session_id
            print_result(message)

    if not session_id:
        return None

    print(f"\n[저장된 session_id: {session_id}]")
    print("[이 ID를 Redis/DB에 저장해두면 프로세스 재시작 후에도 재개 가능]\n")

    # 두 번째 대화: 앞 세션 이어받기
    async for message in query(
        prompt="그 도시의 현재 인구는 얼마인가요?",  # "그 도시" = 서울
        options=ClaudeAgentOptions(resume=session_id),
    ):
        if isinstance(message, AssistantMessage):
            _print_text(message)
        elif isinstance(message, ResultMessage):
            print_result(message)

    return session_id


async def session_management(session_id: str | None) -> None:
    """
    패턴 3: 세션 목록 조회, 이름 변경, 태그 설정.
    list_sessions()로 최근 세션을 확인하고,
    rename_session/tag_session으로 정리할 수 있다.
    """
    print("\n" + "=" * 50)
    print("패턴 3: 세션 관리")
    print("=" * 50)

    # 최근 5개 세션 조회
    sessions = list_sessions(limit=5)
    print(f"최근 세션 {len(sessions)}개:")
    for s in sessions:
        print(f"  {s.session_id[:16]}... | {s.summary or '(제목 없음)'}")

    if session_id:
        # 세션에 사람이 읽기 쉬운 제목 설정
        rename_session(session_id, "서울 인구 질문 세션")
        print(f"\n세션 이름 변경 완료: {session_id[:16]}...")

        # 세션에 태그 추가 (검색/분류용)
        tag_session(session_id, "geography")
        print(f"태그 추가 완료: geography")


async def main() -> None:
    await in_memory_client()
    session_id = await manual_session_resume()
    await session_management(session_id)


if __name__ == "__main__":
    asyncio.run(main())
