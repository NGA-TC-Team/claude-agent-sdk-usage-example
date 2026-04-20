"""
with-workflow/workflow.py — AI 에이전트 워크플로우 예제 (Python)

"코드베이스 감사 에이전트"를 통해 5단계 워크플로우를 구현한다:

  1. GATHER  — 지식 수집: 프로젝트 파일 탐색 및 구조 파악
  2. PLAN    — 계획 수립: structured output으로 감사 계획 JSON 생성
  3. EXECUTE — 실행: 계획 단계별 순차/병렬 실행
  4. VERIFY  — 결과 점검: 독립 Critic 에이전트 검토 + 반복 개선
  5. REPORT  — 보고: 구조화 출력 + 마크다운 파일 저장
"""

from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent))

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    HookMatcher,
    ResultMessage,
    SystemMessage,
    query,
)
from claude_agent_sdk.types import TextBlock

from utils.utils import format_cost, print_result

# ─── 프로젝트 경로 ────────────────────────────────────────────────────────────

PROJECT_ROOT = str(Path(__file__).parent.parent)
REPORT_DIR = Path(__file__).parent / "reports"
AUDIT_LOG = Path(__file__).parent / "workflow_audit.log"

# ─── 스키마 정의 ──────────────────────────────────────────────────────────────

# 계획 수립에 사용할 JSON 스키마
PLAN_SCHEMA = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {
            "goal": {"type": "string"},
            "scope": {"type": "string"},
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "integer"},
                        "phase": {"type": "string"},
                        "action": {"type": "string"},
                        "tools": {"type": "array", "items": {"type": "string"}},
                        "depends_on": {"type": "array", "items": {"type": "integer"}},
                    },
                    "required": ["id", "phase", "action", "tools", "depends_on"],
                },
            },
        },
        "required": ["goal", "scope", "steps"],
    },
}

# 검토 결과 스키마
CRITIC_SCHEMA = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {
            "passed": {"type": "boolean"},
            "score": {"type": "number", "minimum": 0, "maximum": 10},
            "issues": {"type": "array", "items": {"type": "string"}},
            "suggestions": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["passed", "score", "issues", "suggestions"],
    },
}

# 최종 보고서 스키마
REPORT_SCHEMA = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "summary": {"type": "string"},
            "severity": {
                "type": "string",
                "enum": ["low", "medium", "high", "critical"],
            },
            "findings": {"type": "array", "items": {"type": "string"}},
            "recommendations": {"type": "array", "items": {"type": "string"}},
            "next_steps": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["title", "summary", "severity", "findings", "recommendations", "next_steps"],
    },
}


# ─── 공통 유틸 ────────────────────────────────────────────────────────────────

def log(phase: str, message: str) -> None:
    """단계별 진행 상황을 콘솔과 로그 파일에 기록한다."""
    timestamp = datetime.now().strftime("%H:%M:%S")
    line = f"[{timestamp}] [{phase}] {message}"
    print(line)
    with open(AUDIT_LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def print_assistant_text(message: Any) -> None:
    """AssistantMessage에서 텍스트 블록만 출력한다."""
    if isinstance(message, AssistantMessage):
        for block in message.content:
            if isinstance(block, TextBlock):
                print(f"  {block.text}")


def make_tool_hook(phase: str):
    """각 단계에서 사용되는 PostToolUse 훅 팩토리."""
    async def hook(input_data: dict, tool_use_id: str, context) -> dict:
        tool_name = input_data.get("tool_name", "?")
        tool_input = input_data.get("tool_input", {})
        detail = tool_input.get("file_path") or tool_input.get("command", "")
        log(phase, f"  ↳ {tool_name}({str(detail)[:60]})")
        return {}
    return hook


# ─── 단계 1: 지식 수집 (GATHER) ───────────────────────────────────────────────

async def gather_knowledge() -> str:
    """
    프로젝트 파일 구조를 탐색하고 핵심 내용을 파악한다.
    Read, Glob, Grep만 허용 — 읽기 전용으로 안전하게 실행한다.
    반환값: session_id (이후 단계에서 컨텍스트 유지에 사용)
    """
    log("GATHER", "프로젝트 파일 탐색 시작")

    session_id: str | None = None

    options = ClaudeAgentOptions(
        allowed_tools=["Read", "Glob", "Grep"],
        cwd=PROJECT_ROOT,
        hooks={
            "PostToolUse": [HookMatcher(matcher=None, hooks=[make_tool_hook("GATHER")])]
        },
    )

    async for message in query(
        prompt=(
            "이 Python 프로젝트의 구조를 파악해주세요.\n"
            "1. 모든 .py 파일 목록을 확인하세요\n"
            "2. 각 파일의 주요 함수/클래스를 파악하세요\n"
            "3. 파일 간 import 관계를 분석하세요\n"
            "4. 전체 구조를 간결하게 요약해주세요"
        ),
        options=options,
    ):
        print_assistant_text(message)
        if isinstance(message, ResultMessage):
            session_id = message.session_id
            log("GATHER", f"완료 | 비용: {format_cost(message.total_cost_usd)} | 세션: {session_id[:16]}...")
            print_result(message)

    if not session_id:
        raise RuntimeError("지식 수집 단계 실패: session_id를 얻지 못했습니다")

    return session_id


# ─── 단계 2: 계획 수립 (PLAN) ─────────────────────────────────────────────────

async def create_plan(session_id: str) -> tuple[dict, str]:
    """
    수집한 지식을 바탕으로 감사 계획을 JSON으로 수립한다.
    structured output을 사용해 계획이 정해진 스키마를 따르도록 강제한다.
    반환값: (plan dict, new session_id)
    """
    log("PLAN", "감사 계획 수립 중...")

    plan: dict = {}
    new_session_id = session_id

    options = ClaudeAgentOptions(
        resume=session_id,  # 1단계에서 파악한 지식 그대로 유지
        allowed_tools=["Read"],  # 추가 파일 읽기만 허용 (실행 없음)
        output_format=PLAN_SCHEMA,  # JSON 스키마로 출력 형식 강제
        system_prompt=(
            "당신은 시니어 소프트웨어 감사 전문가입니다. "
            "파악한 프로젝트 구조를 바탕으로 코드 품질 감사 계획을 수립하세요. "
            "각 단계는 독립적으로 실행 가능해야 합니다."
        ),
    )

    async for message in query(
        prompt=(
            "파악한 프로젝트를 감사하기 위한 단계별 계획을 수립해주세요.\n"
            "각 단계에 필요한 도구와 의존 관계를 명시해주세요.\n"
            "최대 5단계로 작성하세요."
        ),
        options=options,
    ):
        if isinstance(message, ResultMessage):
            plan = message.structured_output or {}
            new_session_id = message.session_id
            log("PLAN", f"계획 수립 완료 | {len(plan.get('steps', []))}개 단계")
            print_result(message)

    if not plan.get("steps"):
        raise RuntimeError("계획 수립 실패: 유효한 계획이 생성되지 않았습니다")

    # 계획을 파일로 저장 (감사 추적용)
    REPORT_DIR.mkdir(exist_ok=True)
    plan_file = REPORT_DIR / f"plan_{datetime.now():%Y%m%d_%H%M%S}.json"
    plan_file.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    log("PLAN", f"계획 저장: {plan_file.name}")

    return plan, new_session_id


# ─── 단계 3: 실행 (EXECUTE) ───────────────────────────────────────────────────

async def execute_step(step: dict, session_id: str) -> tuple[str, str]:
    """
    계획의 단일 단계를 실행한다.
    세션을 resume해 이전 단계의 컨텍스트를 유지한다.
    반환값: (실행 결과 텍스트, new session_id)
    """
    step_result = ""
    new_session_id = session_id

    options = ClaudeAgentOptions(
        resume=session_id,
        # 계획에 명시된 도구만 허용 — 최소 권한 원칙
        allowed_tools=step.get("tools", ["Read"]),
        permission_mode="acceptEdits",
        hooks={
            "PostToolUse": [
                HookMatcher(matcher=None, hooks=[make_tool_hook(f"EXECUTE-{step['id']}")])
            ]
        },
        cwd=PROJECT_ROOT,
    )

    async for message in query(
        prompt=f"다음 감사 단계를 수행해주세요: {step['action']}",
        options=options,
    ):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    step_result += block.text + "\n"
        elif isinstance(message, ResultMessage):
            new_session_id = message.session_id
            log("EXECUTE", f"  단계 {step['id']} 완료 | 비용: {format_cost(message.total_cost_usd)}")

    return step_result.strip(), new_session_id


async def execute_plan(plan: dict, session_id: str) -> tuple[str, str]:
    """
    계획 전체를 실행한다.
    의존성이 없는 단계들은 병렬로, 의존성이 있는 단계들은 순차로 실행한다.
    반환값: (합산된 실행 결과, 마지막 session_id)
    """
    log("EXECUTE", f"{len(plan['steps'])}개 단계 실행 시작")

    steps = plan["steps"]
    completed: dict[int, str] = {}  # {step_id: result}
    current_session_id = session_id

    # 의존성 없는 첫 번째 그룹 — 병렬 실행
    independent = [s for s in steps if not s["depends_on"]]
    if len(independent) > 1:
        log("EXECUTE", f"독립 단계 {len(independent)}개 병렬 실행")
        tasks = [execute_step(s, current_session_id) for s in independent]
        results = await asyncio.gather(*tasks)
        for step, (result, _) in zip(independent, results):
            completed[step["id"]] = result
            log("EXECUTE", f"단계 {step['id']} [{step['phase']}] 완료")
    else:
        for step in independent:
            result, current_session_id = await execute_step(step, current_session_id)
            completed[step["id"]] = result

    # 의존성 있는 단계 — 의존 단계 완료 후 순차 실행
    dependent = [s for s in steps if s["depends_on"]]
    for step in dependent:
        # 모든 의존 단계가 완료될 때까지 대기
        if all(dep_id in completed for dep_id in step["depends_on"]):
            log("EXECUTE", f"단계 {step['id']} [{step['phase']}] 시작")
            result, current_session_id = await execute_step(step, current_session_id)
            completed[step["id"]] = result

    # 모든 결과 합산
    all_results = "\n\n---\n\n".join(
        f"### 단계 {sid}: {steps[sid-1]['action']}\n{result}"
        for sid, result in sorted(completed.items())
        if result
    )

    log("EXECUTE", f"전체 실행 완료 | {len(completed)}개 단계")
    return all_results, current_session_id


# ─── 단계 4: 결과 점검 (VERIFY) ───────────────────────────────────────────────

async def verify_with_critic(execution_result: str, session_id: str) -> tuple[dict, str]:
    """
    독립 Critic 에이전트가 실행 결과를 검토한다.
    원래 세션과 독립적으로 실행되므로 편향 없는 평가가 가능하다.
    반환값: (review dict, session_id)
    """
    log("VERIFY", "독립 Critic 에이전트 검토 시작")

    review: dict = {}

    # 독립 세션으로 실행 — resume 없음
    options = ClaudeAgentOptions(
        system_prompt=(
            "당신은 엄격한 시니어 코드 감사 전문가입니다. "
            "다음 감사 결과를 비판적으로 검토하세요. "
            "모든 문제를 빠짐없이 지적하고, 누락된 항목이 있으면 반드시 언급하세요."
        ),
        output_format=CRITIC_SCHEMA,
    )

    async for message in query(
        prompt=(
            f"다음 코드 감사 결과를 검토해주세요:\n\n"
            f"{execution_result[:3000]}\n\n"
            f"검토 기준:\n"
            f"1. 감사 항목이 충분히 다루어졌는가?\n"
            f"2. 발견된 문제들이 정확한가?\n"
            f"3. 권장 조치가 실행 가능한가?\n"
            f"4. 누락된 중요 항목은 없는가?"
        ),
        options=options,
    ):
        if isinstance(message, ResultMessage):
            review = message.structured_output or {}
            passed = review.get("passed", False)
            score = review.get("score", 0)
            issues_count = len(review.get("issues", []))
            log("VERIFY", f"검토 완료 | 통과: {passed} | 점수: {score}/10 | 문제: {issues_count}개")

    return review, session_id


async def verify_with_iteration(
    plan: dict, execution_result: str, session_id: str, max_iterations: int = 2
) -> tuple[str, str]:
    """
    Critic 검토 결과를 바탕으로 반복 개선한다.
    통과하거나 최대 반복 횟수에 도달할 때까지 재실행한다.
    반환값: (최종 실행 결과, session_id)
    """
    current_result = execution_result
    current_session = session_id

    for iteration in range(max_iterations):
        review, _ = await verify_with_critic(current_result, current_session)

        if review.get("passed"):
            log("VERIFY", f"✓ {iteration + 1}회 검토 통과 (점수: {review.get('score')}/10)")
            break

        issues = review.get("issues", [])
        suggestions = review.get("suggestions", [])

        if not issues:
            log("VERIFY", "검토 통과 (문제 없음)")
            break

        log("VERIFY", f"반복 {iteration + 1}: {len(issues)}개 문제 발견 → 개선 중")

        # 피드백을 반영해 추가 실행
        feedback = "\n".join(f"- {i}" for i in issues)
        suggestion_text = "\n".join(f"- {s}" for s in suggestions)

        extra_result = ""
        options = ClaudeAgentOptions(
            resume=current_session,
            allowed_tools=["Read", "Bash", "Glob", "Grep"],
            cwd=PROJECT_ROOT,
        )

        async for message in query(
            prompt=(
                f"검토에서 다음 문제가 발견되었습니다:\n{feedback}\n\n"
                f"개선 제안:\n{suggestion_text}\n\n"
                f"위 문제들을 보완해서 감사를 보완해주세요."
            ),
            options=options,
        ):
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        extra_result += block.text + "\n"
            elif isinstance(message, ResultMessage):
                current_session = message.session_id

        current_result = current_result + "\n\n### 보완 분석\n" + extra_result
    else:
        log("VERIFY", f"최대 반복({max_iterations}회) 도달 — 현재 결과로 진행")

    return current_result, current_session


# ─── 단계 5: 보고 (REPORT) ────────────────────────────────────────────────────

async def generate_report(
    plan: dict, execution_result: str, session_id: str
) -> dict:
    """
    감사 결과를 구조화된 보고서로 생성하고 마크다운 파일로 저장한다.
    structured_output으로 JSON 보고서를 받고, Write 도구로 파일도 생성한다.
    반환값: 보고서 dict
    """
    log("REPORT", "최종 보고서 생성 중...")

    report: dict = {}
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_path = REPORT_DIR / f"audit_report_{timestamp}.md"

    # 보고서 내용 생성 (structured output)
    options = ClaudeAgentOptions(
        resume=session_id,
        output_format=REPORT_SCHEMA,
        system_prompt=(
            "당신은 기술 보고서 작성 전문가입니다. "
            "감사 결과를 경영진과 개발팀 모두가 이해할 수 있는 명확한 보고서로 작성하세요."
        ),
    )

    async for message in query(
        prompt=(
            "지금까지의 감사 작업을 종합해 최종 보고서를 작성해주세요.\n"
            "summary는 3문장 이내로 핵심만 담아주세요.\n"
            "severity는 발견된 문제의 최고 심각도를 기준으로 판단하세요."
        ),
        options=options,
    ):
        if isinstance(message, ResultMessage):
            report = message.structured_output or {}
            log("REPORT", f"보고서 생성 완료 | 심각도: {report.get('severity', '?').upper()}")
            print_result(message)

    # 마크다운 파일로 저장
    if report:
        REPORT_DIR.mkdir(exist_ok=True)
        md_content = _build_markdown_report(report, plan, timestamp)
        report_path.write_text(md_content, encoding="utf-8")
        log("REPORT", f"보고서 저장: {report_path}")

    return report


def _build_markdown_report(report: dict, plan: dict, timestamp: str) -> str:
    """dict 보고서를 마크다운 문서로 변환한다."""
    severity_emoji = {"low": "🟢", "medium": "🟡", "high": "🟠", "critical": "🔴"}
    sev = report.get("severity", "low")
    emoji = severity_emoji.get(sev, "⚪")

    lines = [
        f"# {report.get('title', '코드 감사 보고서')}",
        f"\n> 생성 일시: {timestamp} | 심각도: {emoji} {sev.upper()}",
        "\n## 요약\n",
        report.get("summary", ""),
        "\n## 주요 발견 사항\n",
        *[f"- {f}" for f in report.get("findings", [])],
        "\n## 권장 조치\n",
        *[f"- {r}" for r in report.get("recommendations", [])],
        "\n## 다음 단계\n",
        *[f"{i+1}. {s}" for i, s in enumerate(report.get("next_steps", []))],
        f"\n---\n*감사 계획 목표: {plan.get('goal', '')}*",
    ]
    return "\n".join(lines)


# ─── 메인 워크플로우 ──────────────────────────────────────────────────────────

async def run_workflow() -> None:
    """
    5단계 워크플로우를 순서대로 실행한다.
    각 단계는 이전 단계의 session_id를 받아 컨텍스트를 유지한다.
    """
    REPORT_DIR.mkdir(exist_ok=True)
    AUDIT_LOG.write_text(
        f"=== 워크플로우 시작: {datetime.now().isoformat()} ===\n",
        encoding="utf-8"
    )

    print("\n" + "█" * 60)
    print("  코드베이스 감사 에이전트 워크플로우")
    print("█" * 60 + "\n")

    try:
        # ── 1단계: 지식 수집 ──────────────────────────────────────
        print("\n[1/5] 지식 수집 (GATHER)")
        print("-" * 40)
        session_id = await gather_knowledge()

        # ── 2단계: 계획 수립 ──────────────────────────────────────
        print("\n[2/5] 계획 수립 (PLAN)")
        print("-" * 40)
        plan, session_id = await create_plan(session_id)

        print(f"\n  목표: {plan['goal']}")
        print(f"  범위: {plan['scope']}")
        print("  단계:")
        for step in plan["steps"]:
            deps = f" (의존: {step['depends_on']})" if step["depends_on"] else ""
            print(f"    {step['id']}. [{step['phase']}] {step['action'][:60]}{deps}")

        # ── 3단계: 실행 ───────────────────────────────────────────
        print("\n[3/5] 계획 실행 (EXECUTE)")
        print("-" * 40)
        execution_result, session_id = await execute_plan(plan, session_id)

        # ── 4단계: 결과 점검 ──────────────────────────────────────
        print("\n[4/5] 결과 점검 (VERIFY)")
        print("-" * 40)
        final_result, session_id = await verify_with_iteration(
            plan, execution_result, session_id, max_iterations=2
        )

        # ── 5단계: 보고 ───────────────────────────────────────────
        print("\n[5/5] 보고서 생성 (REPORT)")
        print("-" * 40)
        report = await generate_report(plan, final_result, session_id)

        # 최종 요약 출력
        print("\n" + "█" * 60)
        print("  워크플로우 완료")
        print("█" * 60)
        print(f"\n  심각도: {report.get('severity', '?').upper()}")
        print(f"  발견 사항: {len(report.get('findings', []))}개")
        print(f"  권장 조치: {len(report.get('recommendations', []))}개")
        print(f"  보고서 위치: {REPORT_DIR}/")
        print(f"  감사 로그: {AUDIT_LOG.name}\n")

    except Exception as e:
        log("ERROR", f"워크플로우 실패: {e}")
        raise


if __name__ == "__main__":
    asyncio.run(run_workflow())
