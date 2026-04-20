"""
application-built-in/saas_app.py — 멀티테넌트 콘텐츠 생성 SaaS API (Python · 인프로세스)

"Claude를 백엔드로 쓰는 B2B SaaS API를 내 앱에 심는" 최소 완성 예제다.
하나의 엔드포인트 `POST /api/v1/generate`로 테넌트별 마케팅 카피를 생성한다.

핵심 SDK 통합 포인트:
  1. API 키 헤더 `x-api-key`로 테넌트 식별 (HTTP 401 at 경계)
  2. 테넌트별 월 쿼터 · 누적 비용 추적 (HTTP 429 at 경계)
  3. `output_format` JSON 스키마로 구조화 출력 — 프런트엔드가 안전히 파싱
  4. `max_turns=2`, `max_budget_usd=0.05`로 요청당 비용 상한
  5. `ResultMessage.total_cost_usd`를 테넌트 사용량 DB에 기록

실행:
  pip install claude-agent-sdk fastapi uvicorn
  export ANTHROPIC_API_KEY=sk-ant-...
  python application-built-in/saas_app.py

테스트 시나리오 (3종):
  # 1) 정상 요청 (200 OK + 구조화 JSON)
  curl -X POST http://localhost:8001/api/v1/generate \\
    -H "x-api-key: tenant_a_secret" -H "content-type: application/json" \\
    -d '{"brief": "노이즈캔슬링 헤드셋 런칭 카피"}'

  # 2) 잘못된 API 키 (401)
  curl -i -X POST http://localhost:8001/api/v1/generate \\
    -H "x-api-key: wrong" -H "content-type: application/json" \\
    -d '{"brief": "x"}'

  # 3) 쿼터 초과 (429) — tenant_b는 호출 쿼터 2, 3회째 시도 시 거절
  for i in 1 2 3; do
    curl -i -X POST http://localhost:8001/api/v1/generate \\
      -H "x-api-key: tenant_b_secret" -H "content-type: application/json" \\
      -d '{"brief": "감성 향수 카피"}'
  done

  # 4) 관리자 사용량 조회
  curl http://localhost:8001/admin/usage
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

from utils.utils import format_cost, print_result

# ─── 테넌트 DB (데모용 · 실전에선 Postgres 등) ───────────────────────────────


@dataclass
class Tenant:
    id: str
    api_key: str
    quota: int  # 허용 호출 수 (데모: 토큰 대신 호출 수로 제한)
    usage_calls: int = 0
    usage_cost_usd: float = 0.0
    recent_sessions: list[str] = field(default_factory=list)


TENANTS: dict[str, Tenant] = {
    t.api_key: t
    for t in [
        Tenant(id="tenant_a", api_key="tenant_a_secret", quota=100),
        Tenant(id="tenant_b", api_key="tenant_b_secret", quota=2),  # 쿼터 초과 시연용
    ]
}

# ─── 구조화 출력 스키마 ──────────────────────────────────────────────────────

GENERATE_SCHEMA = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {
            "headline": {"type": "string", "description": "한 줄 헤드라인 (20자 내외)"},
            "subheadline": {"type": "string"},
            "body": {"type": "string", "description": "3-5문장 본문 카피"},
            "cta": {"type": "string", "description": "Call To Action 문구"},
            "hashtags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "3-5개",
            },
        },
        "required": ["headline", "subheadline", "body", "cta", "hashtags"],
    },
}

SYSTEM_PROMPT = (
    "당신은 브랜드 마케팅 카피라이터입니다. "
    "주어진 제품 brief를 바탕으로 간결하고 임팩트 있는 한국어 카피를 생성하세요. "
    "고객 편익에 집중하고 과장·허위 주장을 피하세요."
)

# ─── 앱 ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="Content Generation SaaS")


class GenerateRequest(BaseModel):
    brief: str


class GenerateResponse(BaseModel):
    content: dict
    usage: dict


def _auth(api_key: str | None) -> Tenant:
    """API 키 검증 → 테넌트 반환. 경계에서 HTTPException으로 바운스."""
    if not api_key:
        raise HTTPException(status_code=401, detail="x-api-key 헤더 필요")
    tenant = TENANTS.get(api_key)
    if not tenant:
        raise HTTPException(status_code=401, detail="유효하지 않은 API 키")
    return tenant


def _check_quota(tenant: Tenant) -> None:
    if tenant.usage_calls >= tenant.quota:
        raise HTTPException(
            status_code=429,
            detail=f"쿼터 초과 ({tenant.usage_calls}/{tenant.quota})",
        )


@app.post("/api/v1/generate", response_model=GenerateResponse)
async def generate(
    body: GenerateRequest,
    x_api_key: str | None = Header(default=None),
) -> GenerateResponse:
    tenant = _auth(x_api_key)
    _check_quota(tenant)

    options = ClaudeAgentOptions(
        system_prompt=SYSTEM_PROMPT,
        # 구조화 출력 — 프런트엔드가 JSON.parse 하나로 끝낼 수 있게
        output_format=GENERATE_SCHEMA,
        # 요청당 비용 상한 — 테넌트가 악용하거나 프롬프트가 루프에 빠지는 것 방지
        max_turns=2,
        max_budget_usd=0.05,
    )

    content: dict = {}
    cost_usd: float = 0.0
    session_id: str | None = None
    status: str = "unknown"

    async for msg in query(prompt=body.brief, options=options):
        if isinstance(msg, ResultMessage):
            print_result(msg)  # 서버 로그
            content = msg.structured_output or {}
            cost_usd = msg.total_cost_usd or 0.0
            session_id = msg.session_id
            status = msg.subtype

    # 테넌트 사용량 기록 — 실전에선 트랜잭션 DB로 대체
    tenant.usage_calls += 1
    tenant.usage_cost_usd += cost_usd
    if session_id:
        tenant.recent_sessions.append(session_id)
        tenant.recent_sessions = tenant.recent_sessions[-20:]

    if status != "success" or not content:
        # 구조화 출력 실패 · 비용 상한 초과 등 → 서버 측에서는 200 대신 502
        raise HTTPException(
            status_code=502,
            detail=f"생성 실패 (status={status})",
        )

    return GenerateResponse(
        content=content,
        usage={
            "tenant_id": tenant.id,
            "calls_used": tenant.usage_calls,
            "quota": tenant.quota,
            "this_request_cost_usd": round(cost_usd, 6),
            "cumulative_cost_usd": round(tenant.usage_cost_usd, 6),
        },
    )


@app.get("/admin/usage")
def admin_usage() -> dict:
    """관리용 사용량 스냅샷. 실전에선 관리자 인증 필수."""
    return {
        t.id: {
            "calls_used": t.usage_calls,
            "quota": t.quota,
            "cost_usd": format_cost(t.usage_cost_usd),
            "recent_sessions": t.recent_sessions[-5:],
        }
        for t in TENANTS.values()
    }


def main() -> None:
    import uvicorn

    if not os.getenv("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY 환경 변수가 필요합니다.")

    print("▶ SaaS API 기동  http://localhost:8001")
    print("  테넌트 A 키: tenant_a_secret  (쿼터 100)")
    print("  테넌트 B 키: tenant_b_secret  (쿼터 2 — 초과 시연용)")
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="info")


if __name__ == "__main__":
    main()
