"""
application-built-in/automation_app.py — 이벤트 드리븐 자동화 워크플로우 (Python · 인프로세스)

"inbox/ 폴더에 파일이 떨어지면 Claude가 자동 분류·요약해 processed/로 옮기는" 백오피스
자동화를 예시한다. 실제로 고객 문의 · 버그 리포트 · 에러 로그 · 문서 정리 등에 바로 확장할 수 있는 구조다.

핵심 SDK 통합 포인트:
  1. `allowed_tools=["Read", "Write"]` + `cwd`로 권한 범위를 감시 폴더로 제한
  2. `output_format` JSON 스키마로 {category, priority, summary, action_items} 강제
  3. 훅(`PostToolUse`)으로 처리 감사 로그 기록
  4. 작업당 `max_budget_usd`로 비용 폭주 방어
  5. 예산 초과·실패 건은 failed/ 폴더로 격리 (DLQ 역할)

실행:
  pip install claude-agent-sdk watchfiles
  export ANTHROPIC_API_KEY=sk-ant-...
  python application-built-in/automation_app.py

동작 시나리오:
  • 시작 시 workspace/ 하위에 inbox/ processed/ failed/ 폴더를 생성
  • 샘플 파일 3개를 inbox/에 자동 투입
  • watchfiles로 파일 생성 이벤트 감지 → Claude로 처리 → 결과 저장
  • 3건 처리 완료 시 자동 종료 (CI 친화)
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from claude_agent_sdk import (
    ClaudeAgentOptions,
    HookMatcher,
    ResultMessage,
    query,
)

from utils.utils import format_cost, print_result

# ─── 경로 설정 ────────────────────────────────────────────────────────────────

WORKSPACE = Path(__file__).parent / "workspace"
INBOX = WORKSPACE / "inbox"
PROCESSED = WORKSPACE / "processed"
FAILED = WORKSPACE / "failed"
AUDIT_LOG = WORKSPACE / "audit.log"

# ─── 스키마 ──────────────────────────────────────────────────────────────────

CLASSIFY_SCHEMA = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {
            "category": {
                "type": "string",
                "enum": ["bug_report", "feature_request", "complaint", "question", "other"],
            },
            "priority": {"type": "string", "enum": ["low", "medium", "high", "critical"]},
            "summary": {"type": "string", "description": "2-3 문장 한국어 요약"},
            "action_items": {"type": "array", "items": {"type": "string"}},
            "suggested_assignee": {
                "type": "string",
                "enum": ["support", "engineering", "product", "billing"],
            },
        },
        "required": ["category", "priority", "summary", "action_items", "suggested_assignee"],
    },
}

SYSTEM_PROMPT = (
    "당신은 고객 지원 트리아지 자동화 에이전트입니다. "
    "주어진 문서 파일을 읽고 분류·요약하세요. "
    "파일 내용이 모호하면 'other'와 'low'로 분류하세요."
)

# ─── 감사 로그 훅 ─────────────────────────────────────────────────────────────

async def audit_hook(input_data: dict, tool_use_id: str, context) -> dict:
    """PostToolUse 훅 — 도구 사용을 감사 파일에 기록."""
    ts = datetime.now().isoformat(timespec="seconds")
    tool = input_data.get("tool_name", "?")
    tool_input = json.dumps(input_data.get("tool_input", {}), ensure_ascii=False)[:200]
    with AUDIT_LOG.open("a", encoding="utf-8") as f:
        f.write(f"[{ts}] {tool}  {tool_input}\n")
    return {}

# ─── 파일 처리 ────────────────────────────────────────────────────────────────

async def process_file(path: Path) -> None:
    """단일 파일을 Claude로 분류·요약 후 processed/ 또는 failed/로 이동."""
    print(f"→ 처리 시작: {path.name}")

    options = ClaudeAgentOptions(
        system_prompt=SYSTEM_PROMPT,
        # 감시 폴더 밖으로 나가지 못하도록 권한·작업 디렉토리를 강제
        cwd=str(WORKSPACE),
        allowed_tools=["Read"],
        output_format=CLASSIFY_SCHEMA,
        max_turns=3,
        # 작업당 비용 상한 — 트리거 폭주 대비
        max_budget_usd=0.03,
        hooks={"PostToolUse": [HookMatcher(matcher=None, hooks=[audit_hook])]},
    )

    prompt = (
        f"파일 `inbox/{path.name}`을(를) 읽고 정해진 스키마에 맞춰 분류·요약하세요."
    )

    result: dict = {}
    cost_usd: float = 0.0
    status = "unknown"
    session_id: str | None = None

    try:
        async for msg in query(prompt=prompt, options=options):
            if isinstance(msg, ResultMessage):
                print_result(msg)
                result = msg.structured_output or {}
                cost_usd = msg.total_cost_usd or 0.0
                status = msg.subtype
                session_id = msg.session_id
    except Exception as exc:  # SDK 자체 오류
        status = "exception"
        result = {"error": str(exc)}

    # 결과 저장
    if status == "success" and result:
        dest = PROCESSED / path.name
        meta = PROCESSED / f"{path.stem}.meta.json"
    else:
        dest = FAILED / path.name
        meta = FAILED / f"{path.stem}.meta.json"

    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), dest)
    meta.write_text(
        json.dumps(
            {
                "filename": path.name,
                "status": status,
                "cost_usd": cost_usd,
                "session_id": session_id,
                "classification": result,
                "processed_at": datetime.now().isoformat(timespec="seconds"),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"✓ 저장: {dest.relative_to(WORKSPACE)}  |  cost {format_cost(cost_usd)}")

# ─── 샘플 시드 ────────────────────────────────────────────────────────────────

SAMPLES = {
    "ticket_001.txt": (
        "안녕하세요, 오늘 오전부터 결제 화면에서 '서버 오류'가 뜨면서 결제가 완료되지 않습니다. "
        "크롬·사파리 모두 동일하고, 환불 금액도 지연되고 있습니다. 긴급 확인 부탁드립니다."
    ),
    "ticket_002.txt": (
        "대시보드에 월별 매출 비교 그래프 기능을 추가해 주시면 좋겠습니다. "
        "지금은 일별만 있는데 기획자 리뷰 때 월 단위가 훨씬 편합니다."
    ),
    "ticket_003.txt": (
        "SDK 문서 예제 오타 제보드립니다. 로그인 섹션의 `autneticate` → `authenticate` 입니다."
    ),
}


def seed_samples() -> None:
    INBOX.mkdir(parents=True, exist_ok=True)
    PROCESSED.mkdir(parents=True, exist_ok=True)
    FAILED.mkdir(parents=True, exist_ok=True)
    AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
    AUDIT_LOG.touch(exist_ok=True)

    for name, body in SAMPLES.items():
        (INBOX / name).write_text(body, encoding="utf-8")

# ─── 감시 루프 ────────────────────────────────────────────────────────────────

async def watch_and_process(target_count: int) -> None:
    from watchfiles import Change, awatch

    processed_count = 0
    # 시드된 파일을 먼저 즉시 처리 (watchfiles는 이미 존재하는 파일 이벤트를 주지 않음)
    existing = sorted(INBOX.glob("*"))
    for path in existing:
        if path.is_file():
            await process_file(path)
            processed_count += 1
            if processed_count >= target_count:
                return

    # 이후 들어오는 신규 파일 감시
    async for changes in awatch(INBOX, stop_event=None):
        for change, raw in changes:
            if change != Change.added:
                continue
            p = Path(raw)
            if not p.is_file():
                continue
            # 쓰기 완료 대기 (작은 디바운스)
            await asyncio.sleep(0.2)
            await process_file(p)
            processed_count += 1
            if processed_count >= target_count:
                return


async def main() -> None:
    if not os.getenv("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY 환경 변수가 필요합니다.")

    print(f"▶ 자동화 워크스페이스: {WORKSPACE}")
    seed_samples()
    print(f"  시드 파일 {len(SAMPLES)}개 투입 → 처리 대기\n")

    t0 = time.time()
    await watch_and_process(target_count=len(SAMPLES))
    print(f"\n[완료]  총 소요 {time.time() - t0:.1f}s  →  processed/ 확인")


if __name__ == "__main__":
    asyncio.run(main())
