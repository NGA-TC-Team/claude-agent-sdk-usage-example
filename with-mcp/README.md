# with-mcp — MCP 서버 연동

## MCP란?

MCP(Model Context Protocol)는 **AI 에이전트와 외부 시스템을 연결하는 오픈 표준 프로토콜**이다.
데이터베이스, GitHub, Slack, 브라우저 등 수백 가지 서비스를 Claude에 연결할 수 있다.

MCP 서버는 도구를 제공하고, Claude는 그 도구를 빌트인 도구처럼 호출한다.

---

## 도구명 컨벤션

MCP 도구는 `mcp__<서버명>__<도구명>` 형태로 명명된다.

예: `github` 서버의 `list_issues` 도구 → `mcp__github__list_issues`

와일드카드로 서버 전체 도구를 한 번에 허용할 수 있다:
```python
allowed_tools=["mcp__github__*"]
```

---

## Transport 종류

| Transport | 사용 시기 | 설정 |
|-----------|-----------|------|
| **stdio** | 로컬 프로세스 (npx, uvx 등) | `command`, `args` |
| **SSE** | 원격 서버 (실시간 스트림) | `type: "sse"`, `url` |
| **HTTP** | 원격 서버 (단순 요청) | `type: "http"`, `url` |

### stdio 예시 (로컬 실행)

```python
mcp_servers={
    "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
}
```

### HTTP 예시 (원격 서버)

```python
mcp_servers={
    "docs": {
        "type": "http",
        "url": "https://code.claude.com/docs/mcp"
    }
}
```

---

## .mcp.json 파일 기반 설정

프로젝트 루트에 `.mcp.json`을 두면 코드 수정 없이 서버를 추가할 수 있다.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

---

## 연결 상태 확인

`query()` 시작 시 `SystemMessage(subtype="init")`이 먼저 도착한다.
여기서 각 서버의 연결 상태를 확인할 수 있다.

```python
if isinstance(msg, SystemMessage) and msg.subtype == "init":
    servers = msg.data.get("mcp_servers", [])
    for s in servers:
        print(f"{s['name']}: {s['status']}")  # connected | failed | ...
```

---

## 오류 처리

- `failed`: 서버 프로세스 실행 실패 (npx 패키지 없음, 인증 오류 등)
- `needs-auth`: OAuth 인증 필요
- `pending`: 연결 중

---

## 실행

```bash
# 파일시스템 MCP 서버 설치 (Node.js 필요)
npm install -g @modelcontextprotocol/server-filesystem

python with-mcp/mcp.py
bun run with-mcp/mcp.ts
```
