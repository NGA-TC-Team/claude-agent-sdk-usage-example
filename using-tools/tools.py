"""
using-tools/tools.py — 도구 활용 예제 (Python)

세 가지 패턴을 보여준다:
1. 읽기 전용 에이전트: Read, Glob, Grep만 허용
2. 편집 에이전트: acceptEdits 모드로 파일 수정 자동 승인
3. 훅 로깅: PostToolUse 훅으로 모든 도구 실행을 감사 로그에 기록
"""

import asyncio
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    HookMatcher,
    ResultMessage,
    query,
)
from claude_agent_sdk.types import TextBlock

from utils.utils import print_result


async def readonly_agent() -> None:
    """
    패턴 1: 읽기 전용 에이전트.
    Read, Glob, Grep만 허용해 파일 수정 없이 코드베이스를 분석한다.
    CI/CD에서 코드 리뷰나 분석 작업에 적합하다.
    """
    print("=" * 50)
    print("패턴 1: 읽기 전용 에이전트")
    print("=" * 50)

    # 현재 프로젝트의 Python 파일 구조를 분석하도록 요청
    project_root = str(Path(__file__).parent.parent)

    options = ClaudeAgentOptions(
        allowed_tools=["Read", "Glob", "Grep"],
        # bypassPermissions 없이 읽기 도구만 허용 — 가장 안전한 설정
        cwd=project_root,
    )

    async for message in query(
        prompt=(
            "이 프로젝트의 Python 파일 목록을 찾아서 "
            "각 파일이 어떤 역할을 하는지 한 줄씩 설명해주세요."
        ),
        options=options,
    ):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(block.text)
        elif isinstance(message, ResultMessage):
            print_result(message)


async def hook_logging() -> None:
    """
    패턴 2: PostToolUse 훅으로 도구 실행 감사 로그 기록.
    모든 도구 실행 후 audit.log에 기록한다.
    보안 감사나 디버깅에 유용하다.
    """
    print("\n" + "=" * 50)
    print("패턴 2: 훅으로 도구 실행 로깅")
    print("=" * 50)

    log_path = Path(__file__).parent / "audit.log"

    async def log_tool_use(input_data: dict, tool_use_id: str, context) -> dict:
        """
        PostToolUse 훅 콜백.
        모든 도구 실행 직후 호출되며, 도구명과 주요 인자를 로그에 기록한다.
        """
        tool_name = input_data.get("tool_name", "unknown")
        tool_input = input_data.get("tool_input", {})

        # 도구별로 의미 있는 정보만 추출
        detail = ""
        if tool_name in ("Read", "Write", "Edit"):
            detail = tool_input.get("file_path", "")
        elif tool_name == "Bash":
            cmd = tool_input.get("command", "")
            detail = cmd[:60]  # 너무 긴 명령은 잘라냄

        with open(log_path, "a", encoding="utf-8") as f:
            f.write(
                f"{datetime.now().isoformat()} | {tool_name} | {detail}\n"
            )

        # 빈 dict 반환 = 도구 실행 그대로 진행
        return {}

    options = ClaudeAgentOptions(
        allowed_tools=["Read", "Glob", "Grep", "Bash"],
        hooks={
            # matcher=None 이면 모든 도구에 적용
            "PostToolUse": [HookMatcher(matcher=None, hooks=[log_tool_use])]
        },
        cwd=str(Path(__file__).parent.parent),
    )

    async for message in query(
        prompt="utils/utils.py 파일을 읽고 어떤 함수들이 있는지 알려주세요.",
        options=options,
    ):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(block.text)
        elif isinstance(message, ResultMessage):
            print_result(message)

    if log_path.exists():
        print(f"\n[감사 로그 ({log_path.name}):]")
        print(log_path.read_text(encoding="utf-8"))


async def edit_agent() -> None:
    """
    패턴 3: acceptEdits 모드 — 파일 편집 자동 승인.
    Edit, Write 도구 사용 시 매번 승인 요청 없이 자동으로 실행한다.
    자동화 파이프라인이나 CI 환경에서 파일 수정이 필요할 때 사용한다.

    주의: 이 예제는 실제 파일을 수정하지 않도록 /tmp 경로를 사용한다.
    """
    print("\n" + "=" * 50)
    print("패턴 3: acceptEdits 모드 (파일 편집 자동 승인)")
    print("=" * 50)

    import tempfile

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False, encoding="utf-8"
    ) as f:
        f.write("# TODO: fix this\ndef add(a, b):\n    return a - b  # 버그!\n")
        tmp_path = f.name

    print(f"[테스트 파일 생성: {tmp_path}]")

    options = ClaudeAgentOptions(
        allowed_tools=["Read", "Edit"],
        # acceptEdits: Edit/Write 도구를 사용자 확인 없이 자동 승인
        permission_mode="acceptEdits",
    )

    async for message in query(
        prompt=f"{tmp_path} 파일의 버그를 찾아서 수정해주세요.",
        options=options,
    ):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(block.text)
        elif isinstance(message, ResultMessage):
            print_result(message)

    # 수정 결과 확인
    print(f"\n[수정된 파일 내용:]\n{Path(tmp_path).read_text(encoding='utf-8')}")
    Path(tmp_path).unlink()  # 임시 파일 정리


async def main() -> None:
    await readonly_agent()
    await hook_logging()
    await edit_agent()


if __name__ == "__main__":
    asyncio.run(main())
