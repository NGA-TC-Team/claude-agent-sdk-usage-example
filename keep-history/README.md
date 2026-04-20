# keep-history — 대화 히스토리 관리

Claude Agent SDK는 대화 내용을 **세션 파일**로 디스크에 자동 저장한다.
이를 활용하면 별도의 메시지 배열 없이도 멀티-턴 대화를 구현할 수 있다.

---

## SDK가 히스토리를 관리하는 방식

세션 파일 저장 위치:
```
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
```
`<encoded-cwd>`는 작업 디렉토리의 절대 경로에서 영숫자가 아닌 문자를 `-`로 치환한 값이다.

---

## 히스토리를 이어받는 세 가지 방법

### 1. ClaudeSDKClient (Python) / continue: true (TypeScript)

가장 간단한 방법. 같은 프로세스 안에서 여러 질문을 연속으로 보낼 때 사용한다.
SDK가 session_id를 내부적으로 관리하므로 직접 추적할 필요가 없다.

```python
async with ClaudeSDKClient() as client:
    await client.query("프랑스 수도는?")
    async for msg in client.receive_response(): ...

    await client.query("그 도시의 인구는?")  # 앞 대화 맥락 유지
    async for msg in client.receive_response(): ...
```

### 2. session_id 캡처 후 resume

프로세스가 재시작되거나 특정 세션으로 돌아가야 할 때 사용한다.
`ResultMessage.session_id`를 저장해두고 `resume=` 옵션으로 재개한다.

```python
session_id = None
async for msg in query(prompt="...", options=ClaudeAgentOptions(...)):
    if isinstance(msg, ResultMessage):
        session_id = msg.session_id  # 저장

# 나중에
async for msg in query(prompt="이어서...", options=ClaudeAgentOptions(resume=session_id)):
    ...
```

### 3. continue_conversation=True

가장 최근 세션을 자동으로 이어받는다. session_id를 몰라도 된다.
프로세스 재시작 후 직전 대화를 그대로 계속할 때 유용하다.

---

## 인메모리 외 외부 스토리지로 확장하기

SDK 세션은 로컬 파일 기반이다. 멀티-유저 서버 환경이나
여러 머신에서 세션을 공유해야 한다면 **session_id를 외부 DB에 저장**하면 된다.

### Redis (빠른 키-값 저장)

```python
import redis

r = redis.Redis(host="localhost", port=6379)

# 세션 저장
r.set(f"session:{user_id}", session_id, ex=86400)  # 24시간 TTL

# 세션 조회
saved_id = r.get(f"session:{user_id}")
if saved_id:
    options = ClaudeAgentOptions(resume=saved_id.decode())
```

### PostgreSQL / SQLite (관계형 DB)

```sql
CREATE TABLE sessions (
    user_id   TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
```

```python
# 저장
cursor.execute(
    "INSERT INTO sessions (user_id, session_id) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET session_id=excluded.session_id",
    (user_id, session_id)
)

# 조회
cursor.execute("SELECT session_id FROM sessions WHERE user_id = ?", (user_id,))
row = cursor.fetchone()
if row:
    options = ClaudeAgentOptions(resume=row[0])
```

> **주의**: 세션 파일 자체(`~/.claude/projects/.../*.jsonl`)는 여전히 로컬에만 존재한다.
> 다른 머신에서 resume하려면 해당 파일도 같은 경로에 복사해야 한다.

---

## 실행

```bash
# Python
python keep-history/history.py

# TypeScript
bun run keep-history/history.ts
```
