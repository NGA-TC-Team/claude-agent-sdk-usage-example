"""
with-mcp/mcp.py — MCP 서버 연동 예제 (Python)

두 가지 패턴을 보여준다:
1. filesystem MCP 서버 (stdio): 로컬 파일 탐색
2. HTTP MCP 서버: Claude Code 공식 문서 서버 연결
"""

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    SystemMessage,
    query,
)
from claude_agent_sdk.types import TextBlock

from utils.utils import print_result


async def filesystem_mcp() -> None:
    """
    패턴 1: filesystem MCP 서버 (stdio transport).
    npx로 로컬에 서버를 실행하고 파일 시스템 도구를 사용한다.

    사전 조건: Node.js 설치 필요
    서버가 없으면 npx가 자동으로 설치함.
    """
    print("=" * 50)
    print("패턴 1: filesystem MCP 서버 (stdio)")
    print("=" * 50)

    project_root = str(Path(__file__).parent.parent)

    options = ClaudeAgentOptions(
        mcp_servers={
            "filesystem": {
                # stdio transport: command로 로컬 프로세스를 실행
                "command": "npx",
                "args": [
                    "-y",
                    "@modelcontextprotocol/server-filesystem",
                    project_root,  # 접근 허용할 디렉토리
                ],
            }
        },
        # mcp__<서버명>__* 으로 해당 서버의 모든 도구를 허용
        allowed_tools=["mcp__filesystem__*"],
    )

    async for message in query(
        prompt=(
            f"{project_root} 디렉토리의 구조를 탐색하고 "
            "주요 파일들을 나열해주세요."
        ),
        options=options,
    ):
        # 연결 상태 확인: init SystemMessage에서 서버 상태를 볼 수 있다
        if isinstance(message, SystemMessage) and message.subtype == "init":
            servers = message.data.get("mcp_servers", [])
            for s in servers:
                print(f"[MCP 서버] {s.get('name')}: {s.get('status')}")

        elif isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(block.text)

        elif isinstance(message, ResultMessage):
            print_result(message)


async def http_mcp() -> None:
    """
    패턴 2: HTTP MCP 서버 (원격 서버).
    Claude Code 공식 문서 MCP 서버에 연결해 문서를 조회한다.
    별도 설치 없이 URL만으로 연결할 수 있다.
    """
    print("\n" + "=" * 50)
    print("패턴 2: HTTP MCP 서버 (원격)")
    print("=" * 50)

    options = ClaudeAgentOptions(
        mcp_servers={
            "claude-code-docs": {
                # HTTP transport: URL로 원격 서버에 연결
                "type": "http",
                "url": "https://code.claude.com/docs/mcp",
            }
        },
        allowed_tools=["mcp__claude-code-docs__*"],
    )

    async for message in query(
        prompt=(
            "Claude Agent SDK의 sessions 기능에 대해 "
            "문서를 참조해서 설명해주세요."
        ),
        options=options,
    ):
        if isinstance(message, SystemMessage) and message.subtype == "init":
            servers = message.data.get("mcp_servers", [])
            for s in servers:
                status = s.get("status")
                name = s.get("name")
                if status != "connected":
                    print(f"[경고] MCP 서버 '{name}' 연결 실패: {status}")
                else:
                    print(f"[MCP 서버] {name}: {status}")

        elif isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(block.text)

        elif isinstance(message, ResultMessage):
            if message.subtype == "error_during_execution":
                print("[오류] 실행 중 오류 발생")
            print_result(message)


async def main() -> None:
    await filesystem_mcp()
    await http_mcp()


if __name__ == "__main__":
    asyncio.run(main())
