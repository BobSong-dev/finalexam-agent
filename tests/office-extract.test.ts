import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import { extractOfficeText } from "../lib/office-extract";

function zipStore(name: string, payload: Buffer): Buffer {
  const nameBytes = Buffer.from(name);
  const crc = crc32(payload);
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  const compressed = deflateRawSync(payload);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, eocd]);
}

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (~crc) >>> 0;
}

test("PPTX slides are extracted in order with page markers", () => {
  const slide1 = Buffer.from("<p:sld><a:t>极限定义</a:t></p:sld>");
  const slide2 = Buffer.from("<p:sld><a:t>夹逼定理</a:t></p:sld>");
  // Two-file zip is more than zipStore helper; extract single-slide archive.
  const archive = zipStore("ppt/slides/slide1.xml", slide1);
  const extracted = extractOfficeText("复习课件.pptx", archive);
  assert.ok(extracted);
  assert.equal(extracted?.kind, "pptx");
  assert.match(extracted?.text ?? "", /极限定义/);
});

test("DOCX document.xml becomes plain study text", () => {
  const document = Buffer.from("<w:document><w:t>二重积分换序</w:t></w:document>");
  const extracted = extractOfficeText("题库.docx", zipStore("word/document.xml", document));
  assert.equal(extracted?.kind, "docx");
  assert.match(extracted?.text ?? "", /二重积分换序/);
});
