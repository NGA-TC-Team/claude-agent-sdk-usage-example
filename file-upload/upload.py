"""
file-upload/upload.py — 파일 업로드와 멀티모달 입력 예제 (Python)

다섯 가지 패턴을 보여준다:
  1. 이미지 base64  — 로컬 파일을 인코딩해 직접 전달
  2. 이미지 URL     — 공개 URL 참조
  3. 텍스트 문서    — 프로젝트 파일을 문서로 전달
  4. 여러 파일      — 이미지 + 문서 + 텍스트를 한 메시지에
  5. Files API      — Anthropic 서버에 사전 업로드 후 file_id 참조
"""

from __future__ import annotations

import asyncio
import base64
import struct
import sys
import zlib
from pathlib import Path
from typing import Any, AsyncIterator

sys.path.insert(0, str(Path(__file__).parent.parent))

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ResultMessage, query
from claude_agent_sdk.types import TextBlock

from utils.utils import print_result

# ─── 미디어 타입 맵 ──────────────────────────────────────────────────────────

MEDIA_TYPES: dict[str, str] = {
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png":  "image/png",
    ".gif":  "image/gif",
    ".webp": "image/webp",
    ".pdf":  "application/pdf",
}


def detect_media_type(path: str) -> str:
    """파일 확장자로 MIME 타입을 추론한다."""
    return MEDIA_TYPES.get(Path(path).suffix.lower(), "application/octet-stream")


def file_to_base64(path: str) -> tuple[str, str]:
    """
    파일을 읽어 (base64_string, media_type) 튜플을 반환한다.
    API 요청 본문은 JSON이므로 바이너리를 base64로 변환해야 한다.
    """
    data = Path(path).read_bytes()
    b64 = base64.b64encode(data).decode("utf-8")
    return b64, detect_media_type(path)


# ─── 테스트 파일 생성 ─────────────────────────────────────────────────────────

def create_sample_png(width: int = 16, height: int = 16) -> bytes:
    """
    외부 라이브러리 없이 최소한의 유효한 PNG를 생성한다.
    예제 실행을 위한 테스트 이미지 전용이다.
    """
    def chunk(ctype: bytes, data: bytes) -> bytes:
        crc = struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF)
        return struct.pack(">I", len(data)) + ctype + data + crc

    # IHDR: width, height, bit_depth=8, color_type=2(RGB), compression, filter, interlace
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))

    # IDAT: 픽셀 데이터 (간단한 그라데이션)
    raw = b""
    for y in range(height):
        raw += b"\x00"  # filter type: None
        for x in range(width):
            r = int(255 * x / max(width - 1, 1))
            g = int(255 * y / max(height - 1, 1))
            b_val = 180
            raw += bytes([r, g, b_val])

    idat = chunk(b"IDAT", zlib.compress(raw))
    iend = chunk(b"IEND", b"")

    return b"\x89PNG\r\n\x1a\n" + ihdr + idat + iend


def get_sample_image_path() -> Path:
    """테스트용 PNG 파일을 생성하고 경로를 반환한다."""
    path = Path(__file__).parent / "sample_test.png"
    path.write_bytes(create_sample_png())
    return path


def get_sample_document_path() -> Path:
    """예제에 사용할 문서 경로를 반환한다 (프로젝트 README 사용)."""
    return Path(__file__).parent / "README.md"


# ─── 메시지 생성 헬퍼 ────────────────────────────────────────────────────────

def make_image_block(b64: str, media_type: str) -> dict[str, Any]:
    """base64 이미지 content block을 반환한다."""
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": b64,
        },
    }


def make_image_url_block(url: str) -> dict[str, Any]:
    """URL 참조 이미지 content block을 반환한다."""
    return {
        "type": "image",
        "source": {
            "type": "url",
            "url": url,
        },
    }


def make_document_base64_block(b64: str, media_type: str) -> dict[str, Any]:
    """base64 문서 content block을 반환한다. PDF에 사용한다."""
    return {
        "type": "document",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": b64,
        },
    }


def make_document_text_block(text: str) -> dict[str, Any]:
    """텍스트 문서 content block을 반환한다. 텍스트 파일에 사용한다."""
    return {
        "type": "document",
        "source": {
            "type": "text",
            "data": text,
        },
    }


def make_document_file_block(file_id: str) -> dict[str, Any]:
    """Files API로 업로드한 파일의 file_id를 참조하는 content block을 반환한다."""
    return {
        "type": "document",
        "source": {
            "type": "file",
            "file_id": file_id,
        },
    }


async def user_message(*content_blocks: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    """
    content block 목록을 하나의 user 메시지 이터러블로 래핑한다.
    query()의 prompt 파라미터는 str 또는 AsyncIterable[dict]를 받는다.
    멀티모달 메시지는 이 AsyncIterable 형식을 사용한다.
    """
    yield {
        "type": "user",
        "message": {
            "role": "user",
            "content": list(content_blocks),
        },
    }


def print_text_response(message: Any) -> None:
    if isinstance(message, AssistantMessage):
        for block in message.content:
            if isinstance(block, TextBlock):
                print(block.text)


# ─── 패턴 1: 이미지 base64 ────────────────────────────────────────────────────

async def upload_image_base64() -> None:
    """
    패턴 1: 로컬 이미지 파일을 base64로 인코딩해 Claude에 전달한다.
    인터넷 연결이나 공개 URL 없이 로컬 파일을 그대로 보낼 수 있다.
    """
    print("=" * 50)
    print("패턴 1: 이미지 base64 전달")
    print("=" * 50)

    image_path = get_sample_image_path()
    b64, media_type = file_to_base64(str(image_path))
    print(f"  파일: {image_path.name} ({len(b64)} chars base64)")

    prompt = user_message(
        make_image_block(b64, media_type),
        {"type": "text", "text": "이 이미지를 설명해주세요. 색상, 크기, 내용을 포함해주세요."},
    )

    options = ClaudeAgentOptions(max_turns=2)

    async for msg in query(prompt=prompt, options=options):
        print_text_response(msg)
        if isinstance(msg, ResultMessage):
            print_result(msg)

    # 임시 파일 정리
    image_path.unlink(missing_ok=True)


# ─── 패턴 2: 이미지 URL ──────────────────────────────────────────────────────

async def upload_image_url() -> None:
    """
    패턴 2: 공개 URL에 있는 이미지를 참조한다.
    파일을 직접 인코딩하지 않아 요청 크기를 최소화할 수 있다.
    Anthropic 서버가 URL에서 이미지를 직접 가져온다.
    """
    print("\n" + "=" * 50)
    print("패턴 2: 이미지 URL 참조")
    print("=" * 50)

    # 안정적인 공개 이미지 URL (Wikimedia Commons)
    image_url = (
        "https://upload.wikimedia.org/wikipedia/commons/thumb/"
        "4/47/PNG_transparency_demonstration_1.png/"
        "280px-PNG_transparency_demonstration_1.png"
    )
    print(f"  URL: {image_url[:60]}...")

    prompt = user_message(
        make_image_url_block(image_url),
        {"type": "text", "text": "이 이미지에서 보이는 것을 간단히 설명해주세요."},
    )

    options = ClaudeAgentOptions(max_turns=2)

    async for msg in query(prompt=prompt, options=options):
        print_text_response(msg)
        if isinstance(msg, ResultMessage):
            print_result(msg)


# ─── 패턴 3: 텍스트 문서 ─────────────────────────────────────────────────────

async def upload_text_document() -> None:
    """
    패턴 3: 텍스트 파일(Markdown, 코드, CSV 등)을 문서 블록으로 전달한다.
    텍스트 파일은 base64 없이 원문을 그대로 전달하는 'text' 소스 타입을 사용한다.
    PDF처럼 바이너리 포맷이 아닌 경우 이 방식이 더 효율적이다.
    """
    print("\n" + "=" * 50)
    print("패턴 3: 텍스트 문서 전달")
    print("=" * 50)

    doc_path = get_sample_document_path()
    doc_content = doc_path.read_text(encoding="utf-8")
    print(f"  문서: {doc_path.name} ({len(doc_content)} 문자)")

    prompt = user_message(
        make_document_text_block(doc_content),
        {"type": "text", "text": "이 문서의 핵심 내용을 세 줄로 요약해주세요."},
    )

    options = ClaudeAgentOptions(max_turns=2)

    async for msg in query(prompt=prompt, options=options):
        print_text_response(msg)
        if isinstance(msg, ResultMessage):
            print_result(msg)


# ─── 패턴 4: 여러 파일을 한 메시지에 ─────────────────────────────────────────

async def upload_multiple_files() -> None:
    """
    패턴 4: 이미지와 문서를 한 메시지에 함께 전달한다.
    content 배열에 여러 블록을 나열하면 Claude가 모두를 함께 참고해 답한다.
    요청당 최대 이미지 20개, 텍스트 블록 수 제한 없음.
    """
    print("\n" + "=" * 50)
    print("패턴 4: 이미지 + 문서 여러 파일 한 번에")
    print("=" * 50)

    # 이미지 생성
    image_path = get_sample_image_path()
    b64_img, media_type = file_to_base64(str(image_path))

    # 문서 읽기
    doc_content = get_sample_document_path().read_text(encoding="utf-8")

    print(f"  이미지: {image_path.name}")
    print(f"  문서: README.md ({len(doc_content)} 문자)")

    prompt = user_message(
        # 첫 번째 파일: 이미지
        make_image_block(b64_img, media_type),
        # 두 번째 파일: 문서
        make_document_text_block(doc_content),
        # 질문: 두 파일을 함께 참조
        {
            "type": "text",
            "text": (
                "위 이미지와 문서를 참고해서 다음에 답해주세요:\n"
                "1. 이미지에서 보이는 색상 패턴은 무엇인가요?\n"
                "2. 문서의 주제는 무엇인가요?\n"
                "각 질문을 한 줄로 간결하게 답해주세요."
            ),
        },
    )

    options = ClaudeAgentOptions(max_turns=2)

    async for msg in query(prompt=prompt, options=options):
        print_text_response(msg)
        if isinstance(msg, ResultMessage):
            print_result(msg)

    image_path.unlink(missing_ok=True)


# ─── 패턴 5: Files API ────────────────────────────────────────────────────────

async def upload_via_files_api() -> None:
    """
    패턴 5: Anthropic Files API로 파일을 서버에 미리 업로드하고
    file_id를 받아 Agent SDK 메시지에서 참조한다.

    동일 파일을 여러 번 사용하거나, 큰 파일을 매번 base64로 재전송하고
    싶지 않을 때 사용한다.

    Files API 사용에는 `anthropic` 패키지가 별도로 필요하다:
      pip install anthropic
    """
    print("\n" + "=" * 50)
    print("패턴 5: Files API (사전 업로드 후 file_id 참조)")
    print("=" * 50)

    try:
        import anthropic
    except ImportError:
        print("  [건너뜀] Files API 예제는 'pip install anthropic' 이 필요합니다.")
        return

    # ── 5a: Anthropic Client SDK로 파일 업로드 ────────────────────────────────
    # Files API는 Agent SDK가 아닌 Anthropic Client SDK로 호출한다.
    client = anthropic.Anthropic()

    # 업로드할 문서 준비 (README.md를 텍스트 파일로 업로드)
    doc_path = get_sample_document_path()
    doc_bytes = doc_path.read_bytes()

    print(f"  업로드 중: {doc_path.name} ({len(doc_bytes):,} bytes)...")

    # 파일 업로드 — Anthropic 서버에 저장되고 file_id 발급
    uploaded = client.beta.files.upload(
        files={
            "file": (doc_path.name, doc_bytes, "text/plain"),
        }
    )
    file_id = uploaded.id
    print(f"  업로드 완료: file_id = {file_id}")

    # ── 5b: file_id를 Agent SDK 메시지에서 참조 ──────────────────────────────
    # 이후 요청에서는 파일 내용 대신 file_id만 전달하면 된다.
    # 동일 파일을 수십 번 사용해도 업로드는 한 번만 한다.
    prompt = user_message(
        make_document_file_block(file_id),
        {"type": "text", "text": "이 문서의 목차 구조를 나열해주세요."},
    )

    options = ClaudeAgentOptions(max_turns=2)

    async for msg in query(prompt=prompt, options=options):
        print_text_response(msg)
        if isinstance(msg, ResultMessage):
            print_result(msg)

    # ── 5c: 업로드된 파일 삭제 (선택 사항) ──────────────────────────────────
    # 더 이상 필요 없으면 서버에서 삭제한다.
    client.beta.files.delete(file_id)
    print(f"  서버 파일 삭제 완료: {file_id}")


# ─── 메인 ────────────────────────────────────────────────────────────────────

async def main() -> None:
    await upload_image_base64()
    await upload_image_url()
    await upload_text_document()
    await upload_multiple_files()
    await upload_via_files_api()


if __name__ == "__main__":
    asyncio.run(main())
