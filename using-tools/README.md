# using-tools — 도구(Tool) 활용

## 도구란?

도구(Tool)는 **Claude가 자율적으로 실행할 수 있는 액션 단위**다.
텍스트 생성에 그치지 않고 파일을 읽고, 코드를 실행하고, 웹을 검색하는 등
실제 작업을 수행할 수 있게 해준다.

Claude는 응답 생성 중 필요하다고 판단하면 도구를 호출하고,
결과를 받아 다음 응답을 이어간다. 이 과정이 **에이전트 루프**다.

---

## 빌트인 도구 목록

| 도구 | 설명 |
|------|------|
| `Read` | 파일 내용 읽기 |
| `Write` | 새 파일 생성 |
| `Edit` | 기존 파일의 특정 부분 수정 |
| `Bash` | 터미널 명령어 실행 (git, test, build 등) |
| `Glob` | 패턴으로 파일 탐색 (`**/*.ts`, `src/**/*.py`) |
| `Grep` | 정규식으로 파일 내용 검색 |
| `WebSearch` | 웹 검색 |
| `WebFetch` | 웹 페이지 내용 가져오기 |
| `AskUserQuestion` | 사용자에게 선택지 제시 후 답변 수집 |
| `Monitor` | 백그라운드 프로세스 출력 모니터링 |

---

## 도구 권한 제어

### allowed_tools

`allowed_tools`에 명시된 도구는 사용자 확인 없이 자동 실행된다.

```python
options = ClaudeAgentOptions(
    allowed_tools=["Read", "Glob", "Grep"]  # 읽기 전용 에이전트
)
```

### permission_mode

| 모드 | 설명 |
|------|------|
| `"default"` | 민감한 작업마다 승인 요청 |
| `"acceptEdits"` | 파일 편집은 자동 승인, 나머지는 확인 |
| `"plan"` | 실행 없이 계획만 수립 |
| `"bypassPermissions"` | 모든 확인 건너뜀 (자동화 환경 전용) |

### disallowed_tools

특정 도구를 명시적으로 차단한다.

```python
options = ClaudeAgentOptions(
    disallowed_tools=["Bash"]  # 명령 실행 금지
)
```

---

## Hooks — 도구 실행 이벤트 처리

훅(Hook)을 사용하면 도구 실행 전후에 커스텀 코드를 실행할 수 있다.

| 이벤트 | 타이밍 |
|--------|--------|
| `PreToolUse` | 도구 실행 직전 |
| `PostToolUse` | 도구 실행 직후 |
| `PostToolUseFailure` | 도구 실행 실패 시 |

```python
async def audit_log(input_data, tool_use_id, context):
    tool = input_data.get("tool_name")
    with open("audit.log", "a") as f:
        f.write(f"{tool} called\n")
    return {}

options = ClaudeAgentOptions(
    hooks={
        "PostToolUse": [HookMatcher(matcher="Edit|Write", hooks=[audit_log])]
    }
)
```

---

## 실행

```bash
python using-tools/tools.py
bun run using-tools/tools.ts
```
