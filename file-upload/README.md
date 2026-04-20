# file-upload — 파일 업로드와 멀티모달 입력

Claude는 텍스트만 처리하는 모델이 아니다.
이미지, PDF, 텍스트 문서 등 다양한 파일 형식을 **한 번의 요청에 함께** 전달해
내용을 분석하거나 텍스트와 함께 추론하게 할 수 있다.

---

## 1. 멀티모달 (Multimodal)

단일 요청에 텍스트 **이외의** 데이터 타입(이미지, 문서 등)을 함께 전달해
AI 모델이 여러 모달리티를 동시에 처리하게 하는 방식이다.

```
텍스트만: "이 보고서 요약해줘"               → 보고서 내용을 텍스트로 붙여 넣어야 함
멀티모달: [PDF 파일] + "이 보고서 요약해줘"  → 파일을 직접 첨부
```

Claude에서 지원하는 멀티모달 입력:

| 입력 타입 | 설명 | API 블록 타입 |
|-----------|------|---------------|
| 이미지 | JPEG, PNG, GIF, WebP | `image` |
| 문서 | PDF, 텍스트, 마크다운, HTML, CSV 등 | `document` |
| 텍스트 | 일반 텍스트 | `text` |

---

## 2. Content Block 구조

Anthropic API는 메시지 내용을 **블록(Block)의 배열**로 구성한다.
각 블록은 `type` 필드로 구분된다.

```json
{
  "role": "user",
  "content": [
    { "type": "image",    "source": { ... } },
    { "type": "document", "source": { ... } },
    { "type": "text",     "text": "이 파일들을 비교해주세요" }
  ]
}
```

한 메시지에 여러 블록을 배열로 나열하면 된다.
블록 순서는 자유롭지만, 텍스트 질문을 마지막에 두는 것이 일반적이다.

---

## 3. Source 타입 — 파일을 전달하는 세 가지 방법

### 3-1. `base64` — 파일을 직접 인코딩해 전달

파일 바이트를 Base64 문자열로 변환해 요청 본문에 포함한다.
외부 URL 없이 로컬 파일을 바로 보낼 수 있어 **가장 범용적인 방법**이다.

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "<base64_encoded_string>"
  }
}
```

```json
{
  "type": "document",
  "source": {
    "type": "base64",
    "media_type": "application/pdf",
    "data": "<base64_encoded_string>"
  }
}
```

**장점**: 로컬 파일을 즉시 전달, 외부 서버 불필요  
**단점**: 요청 크기가 파일 크기만큼 증가 (Base64는 원본의 약 1.33배), 재사용 불가

### 3-2. `url` — 공개 URL 참조

공개적으로 접근 가능한 이미지·PDF URL을 직접 참조한다.
Anthropic 서버가 해당 URL에서 파일을 가져온다.

```json
{
  "type": "image",
  "source": {
    "type": "url",
    "url": "https://example.com/image.png"
  }
}
```

**장점**: 요청 크기 최소화, 이미 CDN에 있는 파일에 최적  
**단점**: URL이 공개적으로 접근 가능해야 함, 서버 방화벽·인증 환경 불가

### 3-3. `file` — Files API로 사전 업로드 후 ID 참조

Anthropic Files API로 파일을 미리 서버에 업로드하고 `file_id`를 받은 뒤,
이후 요청에서 그 ID를 참조한다. 같은 파일을 여러 번 사용할 때 효율적이다.

```json
{
  "type": "document",
  "source": {
    "type": "file",
    "file_id": "file_011CNbrCyeMkMGMT1vGNqy43"
  }
}
```

**장점**: 동일 파일 재전송 없이 ID만으로 반복 참조 가능, 요청 크기 고정  
**단점**: 별도의 업로드 단계 필요, 파일 저장 기간 제한(Anthropic 정책에 따라 변동)

---

## 4. Agent SDK에서 멀티모달 메시지 전달 방법

`query()`의 `prompt` 파라미터는 `str` 외에 **`AsyncIterable[dict]`** 도 받는다.
멀티모달 내용을 전달하려면 이 비동기 이터러블 형식을 사용한다.

```python
async def message_with_image():
    yield {
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", ...}},
                {"type": "text",  "text": "이 이미지를 분석해주세요"}
            ]
        }
    }

async for msg in query(prompt=message_with_image(), options=...):
    ...
```

TypeScript에서는 `async function*` 제너레이터를 사용한다:

```typescript
async function* messageWithImage(b64: string, mediaType: string) {
    yield {
        type: "user",
        message: {
            role: "user",
            content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
                { type: "text", text: "이 이미지를 분석해주세요" }
            ]
        }
    };
}

for await (const msg of query({ prompt: messageWithImage(b64, "image/png"), options: ... })) {
    ...
}
```

---

## 5. 지원 파일 형식과 제한

### 이미지

| 형식 | MIME 타입 | 최대 크기 |
|------|-----------|-----------|
| JPEG | `image/jpeg` | 5 MB |
| PNG | `image/png` | 5 MB |
| GIF | `image/gif` | 5 MB (정지 프레임만) |
| WebP | `image/webp` | 5 MB |

- 요청당 최대 이미지 수: **20개**
- 최대 해상도: 8,000 × 8,000 px

### 문서

| 형식 | MIME 타입 | 최대 크기 |
|------|-----------|-----------|
| PDF | `application/pdf` | 32 MB |
| 텍스트 | `text/plain` | — |
| 마크다운 | `text/markdown` | — |
| HTML | `text/html` | — |
| CSV | `text/csv` | — |

---

## 6. Base64 인코딩

바이너리 파일(이미지, PDF 등)을 ASCII 텍스트로 변환하는 인코딩 방식이다.
JSON은 바이너리를 직접 담을 수 없으므로, API 요청 본문에 파일을 포함하려면 반드시 Base64로 변환해야 한다.

```python
import base64

with open("image.png", "rb") as f:
    b64_string = base64.b64encode(f.read()).decode("utf-8")
    # 결과: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB..."
```

- 원본 대비 **약 33% 크기 증가** (3바이트 → 4문자)
- 디코딩은 역방향: `base64.b64decode(b64_string)`

---

## 7. Files API 개념

Anthropic Files API는 파일을 Anthropic 서버에 **미리 업로드**하고 `file_id`를 받아,
이후 메시지에서 파일 전체를 재전송하지 않고 ID만으로 참조하는 기능이다.

```
일반 흐름:    요청마다 [파일 바이트] 포함 → 매번 전송
Files API:   한 번만 업로드 → file_id 발급 → 이후 요청에 ID만 포함
```

**사용 시나리오:**
- 동일한 문서 기반으로 여러 질문을 반복할 때 (예: 계약서 검토, 보고서 분석)
- 여러 사용자가 같은 파일을 공유하는 SaaS 환경
- 큰 PDF를 매번 재인코딩·전송하지 않고 캐싱하고 싶을 때

Files API 사용에는 **`anthropic` 패키지** (Anthropic Client SDK)가 별도로 필요하다.
Agent SDK만으로는 파일 업로드 API를 직접 호출할 수 없다.

```bash
pip install anthropic        # Python
bun add @anthropic-ai/sdk    # TypeScript
```

---

## 8. 이미지 토큰 비용

이미지는 해상도에 따라 토큰 소비량이 달라진다. 고해상도 이미지는 더 많은 토큰을 소비한다.

| 이미지 크기 | 대략적인 토큰 수 |
|-------------|-----------------|
| 소형 (< 200px) | ~100 토큰 |
| 중형 (800px 내외) | ~800 토큰 |
| 대형 (2000px 이상) | ~2,000 토큰 이상 |

비용 최적화 팁:
- 분석에 충분한 수준으로 이미지를 리사이즈해서 전달 (원본 해상도가 항상 유리하지 않음)
- 같은 파일을 반복 전송한다면 Files API로 ID 참조

---

## 9. 세 가지 방법 비교

| 항목 | base64 | url | Files API |
|------|--------|-----|-----------|
| 사용 편의성 | 높음 | 높음 | 보통 (업로드 단계 필요) |
| 요청 크기 | 큼 (원본+33%) | 최소 | 최소 |
| 파일 재사용 | 불가 (매번 인코딩) | URL이 유효한 동안 | file_id 유효 기간 동안 |
| 인터넷 연결 필요 | 없음 (인코딩만) | 필요 (URL 접근) | 필요 (업로드 시) |
| 비공개 파일 | 가능 | 불가 | 가능 |
| 추가 패키지 | 없음 | 없음 | `anthropic` 필요 |

---

## 실행

```bash
# Python (추가 의존성: Files API 예제)
pip install claude-agent-sdk anthropic
python file-upload/upload.py

# TypeScript (Bun)
bun add @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk
bun run file-upload/upload.ts
```
