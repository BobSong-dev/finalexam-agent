import "server-only";

import { inflateRawSync } from "node:zlib";

const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 400_000;

export interface OfficeExtraction {
  kind: "pptx" | "docx" | "ole" | "unknown";
  pageCount: number;
  text: string;
}

/**
 * 从 Office 文件抽出可供模型使用的正文。PPTX/DOCX 走 ZIP+XML；
 * 旧版 PPT/DOC（OLE）只做可读字符串兜底，不假装版式完整。
 */
export function extractOfficeText(filename: string, bytes: Uint8Array): OfficeExtraction | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1]?.toLowerCase() ?? "";
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (extension === "pptx") return extractPptx(buffer);
  if (extension === "docx") return extractDocx(buffer);
  if (extension === "ppt" || extension === "doc") return extractOleStrings(buffer, extension);
  return undefined;
}

function extractPptx(buffer: Buffer): OfficeExtraction | undefined {
  const files = readZip(buffer);
  if (!files) return undefined;
  const slides = [...files.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  if (!slides.length) return undefined;
  const pages = slides.map((name, index) => {
    const xml = files.get(name);
    const body = xml ? stripXml(xml.toString("utf8")) : "";
    return `--- 第 ${index + 1} 页（幻灯片 ${slideNumber(name)}）---\n${body}`.trim();
  }).filter((page) => page.split("\n").length > 1);
  const text = clipText(pages.join("\n\n"));
  if (!text) return undefined;
  return { kind: "pptx", pageCount: slides.length, text };
}

function extractDocx(buffer: Buffer): OfficeExtraction | undefined {
  const files = readZip(buffer);
  const xml = files?.get("word/document.xml");
  if (!xml) return undefined;
  const body = stripXml(xml.toString("utf8"));
  const text = clipText(body);
  if (!text) return undefined;
  const pageHints = Math.max(1, (body.match(/\f/g) ?? []).length + Math.ceil(body.length / 1800));
  return { kind: "docx", pageCount: pageHints, text };
}

function extractOleStrings(buffer: Buffer, extension: "ppt" | "doc"): OfficeExtraction | undefined {
  const chunks: string[] = [];
  let ascii = "";
  for (let index = 0; index < buffer.length; index += 1) {
    const code = buffer[index]!;
    if (code >= 32 && code < 127) ascii += String.fromCharCode(code);
    else {
      if (ascii.length >= 8) chunks.push(ascii);
      ascii = "";
    }
  }
  if (ascii.length >= 8) chunks.push(ascii);
  for (let index = 0; index + 3 < buffer.length; index += 2) {
    const code = buffer.readUInt16LE(index);
    if (code >= 32 && code < 0xd800) {
      let run = String.fromCharCode(code);
      let cursor = index + 2;
      while (cursor + 1 < buffer.length) {
        const next = buffer.readUInt16LE(cursor);
        if (next < 32 || next >= 0xd800) break;
        run += String.fromCharCode(next);
        cursor += 2;
      }
      if (run.length >= 6) chunks.push(run);
      index = cursor - 2;
    }
  }
  const text = clipText([...new Set(chunks)].filter((item) => /[\u4e00-\u9fff]|[A-Za-z]{4,}/.test(item)).join("\n"));
  if (!text) return undefined;
  return { kind: "ole", pageCount: Math.max(1, Math.ceil(text.length / 1200)), text: `以下由旧版 ${extension.toUpperCase()} 本地抽取，版式可能不完整。\n\n${text}` };
}

function slideNumber(name: string): number {
  const match = /slide(\d+)\.xml$/i.exec(name);
  return match ? Number(match[1]) : 0;
}

function stripXml(xml: string): string {
  return xml
    .replace(/<w:tab\b[^/]*\/>/gi, "\t")
    .replace(/<a:br\b[^/]*\/>/gi, "\n")
    .replace(/<w:br\b[^/]*\/>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, value) => String.fromCharCode(Number(value)))
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clipText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_TEXT_CHARACTERS ? `${trimmed.slice(0, MAX_TEXT_CHARACTERS)}\n\n[正文过长，已截取前段]` : trimmed;
}

function readZip(buffer: Buffer): Map<string, Buffer> | undefined {
  if (buffer.length < 22 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return undefined;
  const eocd = findEocd(buffer);
  if (eocd < 0) return undefined;
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < entryCount && offset + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return files.size ? files : undefined;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name || name.endsWith("/") || uncompressedSize > MAX_ENTRY_BYTES || compressedSize > MAX_ENTRY_BYTES) continue;
    const data = readZipEntry(buffer, localOffset, method, compressedSize, uncompressedSize);
    if (data) files.set(name.replace(/\\/g, "/"), data);
  }
  return files.size ? files : undefined;
}

function findEocd(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - 22 - 65_535);
  for (let index = buffer.length - 22; index >= start; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

function readZipEntry(buffer: Buffer, localOffset: number, method: number, compressedSize: number, uncompressedSize: number): Buffer | undefined {
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) return undefined;
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buffer.length) return undefined;
  const payload = buffer.subarray(dataStart, dataEnd);
  try {
    if (method === 0) return Buffer.from(payload);
    if (method === 8) return inflateRawSync(payload, { maxOutputLength: Math.max(uncompressedSize, 1) });
  } catch {
    return undefined;
  }
  return undefined;
}
