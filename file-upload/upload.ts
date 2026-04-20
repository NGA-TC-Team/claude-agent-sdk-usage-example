/**
 * file-upload/upload.ts — 파일 업로드와 멀티모달 입력 예제 (TypeScript)
 *
 * 다섯 가지 패턴을 보여준다:
 *   1. 이미지 base64  — 로컬 파일을 인코딩해 직접 전달
 *   2. 이미지 URL     — 공개 URL 참조
 *   3. 텍스트 문서    — 프로젝트 파일을 문서로 전달
 *   4. 여러 파일      — 이미지 + 문서 + 텍스트를 한 메시지에
 *   5. Files API      — Anthropic 서버에 사전 업로드 후 file_id 참조
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { printResult } from "../utils/utils.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

type AnyMessage = Record<string, unknown>;
type ContentBlock = Record<string, unknown>;

// ─── 미디어 타입 맵 ──────────────────────────────────────────────────────────

const MEDIA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

function detectMediaType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MEDIA_TYPES[ext] ?? "application/octet-stream";
}

async function fileToBase64(path: string): Promise<[string, string]> {
  /**
   * 파일을 읽어 [base64_string, media_type] 튜플을 반환한다.
   * API 요청 본문은 JSON이므로 바이너리를 base64로 변환해야 한다.
   */
  const data = await readFile(path);
  const b64 = data.toString("base64");
  return [b64, detectMediaType(path)];
}

// ─── 테스트 파일 생성 ─────────────────────────────────────────────────────────

function createSamplePng(width = 16, height = 16): Buffer {
  /**
   * 외부 라이브러리 없이 최소한의 유효한 PNG를 생성한다.
   * 예제 실행을 위한 테스트 이미지 전용이다.
   */
  function makeChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    let crc = 0xffffffff;
    for (const b of typeBytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    crc ^= 0xffffffff;
    crcBuf.writeUInt32BE(crc >>> 0, 0);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
  }

  // CRC 테이블 생성
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c;
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB

  // IDAT: 간단한 그라데이션 픽셀
  const raw = Buffer.alloc((1 + width * 3) * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    raw[pos++] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      raw[pos++] = Math.round(255 * x / Math.max(width - 1, 1));
      raw[pos++] = Math.round(255 * y / Math.max(height - 1, 1));
      raw[pos++] = 180;
    }
  }
  const compressed = deflateSync(raw);

  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "binary"),
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function getSampleImagePath(): Promise<string> {
  const path = join(__dirname, "sample_test.png");
  await writeFile(path, createSamplePng());
  return path;
}

function getSampleDocumentPath(): string {
  return join(__dirname, "README.md");
}

// ─── 메시지 생성 헬퍼 ────────────────────────────────────────────────────────

function makeImageBlock(b64: string, mediaType: string): ContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: b64 },
  };
}

function makeImageUrlBlock(url: string): ContentBlock {
  return {
    type: "image",
    source: { type: "url", url },
  };
}

function makeDocumentBase64Block(b64: string, mediaType: string): ContentBlock {
  return {
    type: "document",
    source: { type: "base64", media_type: mediaType, data: b64 },
  };
}

function makeDocumentTextBlock(text: string): ContentBlock {
  /**
   * 텍스트 파일 전용 블록.
   * base64 인코딩 없이 원문을 바로 전달하므로 텍스트/마크다운에 더 효율적이다.
   */
  return {
    type: "document",
    source: { type: "text", data: text },
  };
}

function makeDocumentFileBlock(fileId: string): ContentBlock {
  /**
   * Files API로 업로드한 파일의 file_id를 참조하는 블록.
   * 파일 내용 대신 ID만 전달하므로 요청 크기가 고정된다.
   */
  return {
    type: "document",
    source: { type: "file", file_id: fileId },
  };
}

async function* userMessage(...blocks: ContentBlock[]) {
  /**
   * content block 목록을 하나의 user 메시지 이터러블로 래핑한다.
   * query()의 prompt 파라미터는 string 또는 AsyncIterable을 받는다.
   * 멀티모달 메시지는 이 AsyncIterable 형식을 사용한다.
   */
  yield {
    type: "user",
    message: {
      role: "user",
      content: blocks,
    },
  };
}

function printTextResponse(message: AnyMessage): void {
  if (message.type !== "assistant") return;
  const content = (message.message as { content: AnyMessage[] }).content;
  for (const block of content) {
    if (block.type === "text") process.stdout.write((block.text as string) + "\n");
  }
}

// ─── 패턴 1: 이미지 base64 ────────────────────────────────────────────────────

async function uploadImageBase64(): Promise<void> {
  /**
   * 패턴 1: 로컬 이미지 파일을 base64로 인코딩해 Claude에 전달한다.
   * 인터넷 연결이나 공개 URL 없이 로컬 파일을 그대로 보낼 수 있다.
   */
  console.log("=".repeat(50));
  console.log("패턴 1: 이미지 base64 전달");
  console.log("=".repeat(50));

  const imagePath = await getSampleImagePath();
  const [b64, mediaType] = await fileToBase64(imagePath);
  console.log(`  파일: sample_test.png (${b64.length} chars base64)`);

  for await (const message of query({
    prompt: userMessage(
      makeImageBlock(b64, mediaType),
      { type: "text", text: "이 이미지를 설명해주세요. 색상, 크기, 내용을 포함해주세요." }
    ),
    options: { maxTurns: 2 },
  })) {
    const msg = message as AnyMessage;
    printTextResponse(msg);
    if (msg.type === "result") printResult(msg);
  }

  await unlink(imagePath).catch(() => {});
}

// ─── 패턴 2: 이미지 URL ──────────────────────────────────────────────────────

async function uploadImageUrl(): Promise<void> {
  /**
   * 패턴 2: 공개 URL에 있는 이미지를 참조한다.
   * 파일을 직접 인코딩하지 않아 요청 크기를 최소화할 수 있다.
   * Anthropic 서버가 URL에서 이미지를 직접 가져온다.
   */
  console.log("\n" + "=".repeat(50));
  console.log("패턴 2: 이미지 URL 참조");
  console.log("=".repeat(50));

  // 안정적인 공개 이미지 URL (Wikimedia Commons)
  const imageUrl =
    "https://upload.wikimedia.org/wikipedia/commons/thumb/" +
    "4/47/PNG_transparency_demonstration_1.png/" +
    "280px-PNG_transparency_demonstration_1.png";

  console.log(`  URL: ${imageUrl.slice(0, 60)}...`);

  for await (const message of query({
    prompt: userMessage(
      makeImageUrlBlock(imageUrl),
      { type: "text", text: "이 이미지에서 보이는 것을 간단히 설명해주세요." }
    ),
    options: { maxTurns: 2 },
  })) {
    const msg = message as AnyMessage;
    printTextResponse(msg);
    if (msg.type === "result") printResult(msg);
  }
}

// ─── 패턴 3: 텍스트 문서 ─────────────────────────────────────────────────────

async function uploadTextDocument(): Promise<void> {
  /**
   * 패턴 3: 텍스트 파일(Markdown, 코드, CSV 등)을 문서 블록으로 전달한다.
   * 텍스트 파일은 base64 없이 원문을 그대로 전달하는 'text' 소스 타입을 사용한다.
   * PDF처럼 바이너리가 아닌 파일에는 이 방식이 더 효율적이다.
   */
  console.log("\n" + "=".repeat(50));
  console.log("패턴 3: 텍스트 문서 전달");
  console.log("=".repeat(50));

  const docPath = getSampleDocumentPath();
  const docContent = await readFile(docPath, "utf-8");
  console.log(`  문서: README.md (${docContent.length} 문자)`);

  for await (const message of query({
    prompt: userMessage(
      makeDocumentTextBlock(docContent),
      { type: "text", text: "이 문서의 핵심 내용을 세 줄로 요약해주세요." }
    ),
    options: { maxTurns: 2 },
  })) {
    const msg = message as AnyMessage;
    printTextResponse(msg);
    if (msg.type === "result") printResult(msg);
  }
}

// ─── 패턴 4: 여러 파일을 한 메시지에 ─────────────────────────────────────────

async function uploadMultipleFiles(): Promise<void> {
  /**
   * 패턴 4: 이미지와 문서를 한 메시지에 함께 전달한다.
   * content 배열에 여러 블록을 나열하면 Claude가 모두를 함께 참고해 답한다.
   */
  console.log("\n" + "=".repeat(50));
  console.log("패턴 4: 이미지 + 문서 여러 파일 한 번에");
  console.log("=".repeat(50));

  const imagePath = await getSampleImagePath();
  const [b64Img, mediaType] = await fileToBase64(imagePath);
  const docContent = await readFile(getSampleDocumentPath(), "utf-8");

  console.log(`  이미지: sample_test.png`);
  console.log(`  문서: README.md (${docContent.length} 문자)`);

  for await (const message of query({
    prompt: userMessage(
      makeImageBlock(b64Img, mediaType),
      makeDocumentTextBlock(docContent),
      {
        type: "text",
        text:
          "위 이미지와 문서를 참고해서 다음에 답해주세요:\n" +
          "1. 이미지에서 보이는 색상 패턴은 무엇인가요?\n" +
          "2. 문서의 주제는 무엇인가요?\n" +
          "각 질문을 한 줄로 간결하게 답해주세요.",
      }
    ),
    options: { maxTurns: 2 },
  })) {
    const msg = message as AnyMessage;
    printTextResponse(msg);
    if (msg.type === "result") printResult(msg);
  }

  await unlink(imagePath).catch(() => {});
}

// ─── 패턴 5: Files API ────────────────────────────────────────────────────────

async function uploadViaFilesApi(): Promise<void> {
  /**
   * 패턴 5: Anthropic Files API로 파일을 서버에 미리 업로드하고
   * file_id를 받아 Agent SDK 메시지에서 참조한다.
   *
   * 동일 파일을 여러 번 사용하거나, 큰 파일을 매번 base64로 재전송하고
   * 싶지 않을 때 사용한다.
   *
   * Files API 사용에는 @anthropic-ai/sdk 패키지가 별도로 필요하다:
   *   bun add @anthropic-ai/sdk
   */
  console.log("\n" + "=".repeat(50));
  console.log("패턴 5: Files API (사전 업로드 후 file_id 참조)");
  console.log("=".repeat(50));

  let Anthropic: typeof import("@anthropic-ai/sdk").default;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    console.log("  [건너뜀] Files API 예제는 'bun add @anthropic-ai/sdk' 이 필요합니다.");
    return;
  }

  // ── 5a: Anthropic Client SDK로 파일 업로드 ────────────────────────────────
  // Files API는 Agent SDK가 아닌 Anthropic Client SDK로 호출한다.
  const client = new Anthropic();

  const docPath = getSampleDocumentPath();
  const docBytes = await readFile(docPath);
  console.log(`  업로드 중: README.md (${docBytes.length.toLocaleString()} bytes)...`);

  // 파일 업로드 — Anthropic 서버에 저장되고 file_id 발급
  const uploaded = await client.beta.files.upload({
    file: new File([docBytes], "README.md", { type: "text/plain" }),
  });
  const fileId = uploaded.id;
  console.log(`  업로드 완료: file_id = ${fileId}`);

  // ── 5b: file_id를 Agent SDK 메시지에서 참조 ──────────────────────────────
  // 이후 요청에서는 파일 내용 대신 file_id만 전달하면 된다.
  // 동일 파일을 수십 번 사용해도 업로드는 한 번만 한다.
  for await (const message of query({
    prompt: userMessage(
      makeDocumentFileBlock(fileId),
      { type: "text", text: "이 문서의 목차 구조를 나열해주세요." }
    ),
    options: { maxTurns: 2 },
  })) {
    const msg = message as AnyMessage;
    printTextResponse(msg);
    if (msg.type === "result") printResult(msg);
  }

  // ── 5c: 업로드된 파일 삭제 (선택 사항) ──────────────────────────────────
  // 더 이상 필요 없으면 서버에서 삭제한다.
  await client.beta.files.delete(fileId);
  console.log(`  서버 파일 삭제 완료: ${fileId}`);
}

// ─── 메인 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await uploadImageBase64();
  await uploadImageUrl();
  await uploadTextDocument();
  await uploadMultipleFiles();
  await uploadViaFilesApi();
}

main().catch(console.error);
