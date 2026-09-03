import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";

const TAR_BLOCK_BYTES = 512;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function fail(message) {
  throw new Error(message);
}

function normalizeRelativePath(value, source, { allowRoot = false, directory = false } = {}) {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) fail(`${source} contains an unsafe path`);
  if (value.includes("\\")) fail(`${source} contains an ambiguous backslash path`);
  if (value.startsWith("/") || /^[a-z]:\//i.test(value)) fail(`${source} contains an absolute path`);

  let relativePath = value;
  while (relativePath.startsWith("./")) relativePath = relativePath.slice(2);
  if (directory) relativePath = relativePath.replace(/\/+$/, "");
  if (!relativePath) {
    if (allowRoot) return "";
    fail(`${source} contains an unsafe path`);
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`${source} contains an unsafe path`);
  }
  return segments.join("/");
}

function parseChecksumLine(raw, expectedBasename) {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length !== 1) fail("archive checksum file must contain exactly one entry");
  const match = /^([a-f0-9]{64})[ \t]+\*?(.+?)\s*$/i.exec(lines[0]);
  if (!match) fail("archive checksum file has an invalid sha256sum entry");
  const recordedBasename = path.posix.basename(match[2].replaceAll("\\", "/"));
  if (recordedBasename !== expectedBasename) fail("archive checksum refers to a different backup file");
  return match[1].toLowerCase();
}

function parseFileManifest(raw) {
  const entries = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})[ \t]+\*?(.+?)\s*$/i.exec(line);
    if (!match) fail("file manifest contains an invalid sha256sum entry");
    const recordedPath = match[2];
    if (!recordedPath.startsWith("./")) fail("file manifest paths must be relative to the data directory");
    const relativePath = normalizeRelativePath(recordedPath, "file manifest");
    if (entries.has(relativePath)) fail("file manifest contains a duplicate path");
    entries.set(relativePath, match[1].toLowerCase());
  }
  if (!entries.size) fail("file manifest is empty");
  if (!entries.has("workspace.json")) fail("file manifest does not include workspace.json");
  return entries;
}

class AsyncByteReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.ended = false;
    this.bytesConsumed = 0;
  }

  async nextChunk() {
    if (this.ended) return undefined;
    const result = await this.iterator.next();
    if (result.done) {
      this.ended = true;
      return undefined;
    }
    return Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value);
  }

  async readExact(length) {
    if (length === 0) return Buffer.alloc(0);
    const pieces = [];
    let remaining = length;
    while (remaining > 0) {
      if (!this.buffer.length) {
        const chunk = await this.nextChunk();
        if (!chunk) {
          if (remaining === length) return undefined;
          fail("tar archive is truncated");
        }
        if (!chunk.length) continue;
        this.buffer = chunk;
      }
      const count = Math.min(remaining, this.buffer.length);
      pieces.push(this.buffer.subarray(0, count));
      this.buffer = this.buffer.subarray(count);
      remaining -= count;
      this.bytesConsumed += count;
    }
    return pieces.length === 1 ? Buffer.from(pieces[0]) : Buffer.concat(pieces, length);
  }

  async consume(length, visitor) {
    let remaining = length;
    while (remaining > 0) {
      if (!this.buffer.length) {
        const chunk = await this.nextChunk();
        if (!chunk) fail("tar archive is truncated");
        if (!chunk.length) continue;
        this.buffer = chunk;
      }
      const count = Math.min(remaining, this.buffer.length);
      const piece = this.buffer.subarray(0, count);
      visitor(piece);
      this.buffer = this.buffer.subarray(count);
      remaining -= count;
      this.bytesConsumed += count;
    }
  }

  async assertOnlyZerosRemain() {
    const assertZero = (chunk) => {
      if (chunk.some((byte) => byte !== 0)) fail("tar archive contains data after its end marker");
    };
    if (this.buffer.length) {
      assertZero(this.buffer);
      this.bytesConsumed += this.buffer.length;
      this.buffer = Buffer.alloc(0);
    }
    while (true) {
      const chunk = await this.nextChunk();
      if (!chunk) {
        if (this.bytesConsumed % TAR_BLOCK_BYTES !== 0) fail("tar archive has a partial trailing block");
        return;
      }
      assertZero(chunk);
      this.bytesConsumed += chunk.length;
    }
  }

  async close() {
    await this.iterator.return?.();
  }
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

function decodeTarText(block, start, length, label) {
  const field = block.subarray(start, start + length);
  const terminator = field.indexOf(0);
  const bytes = terminator >= 0 ? field.subarray(0, terminator) : field;
  try {
    return textDecoder.decode(bytes);
  } catch {
    fail(`tar ${label} is not valid UTF-8`);
  }
}

function parseTarNumber(field, label) {
  if (field[0] & 0x80) fail(`tar ${label} uses an unsupported binary number`);
  const terminator = field.indexOf(0);
  const text = (terminator >= 0 ? field.subarray(0, terminator) : field).toString("ascii").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) fail(`tar ${label} is invalid`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`tar ${label} is outside the supported range`);
  return value;
}

function parseTarHeader(block) {
  const recordedChecksum = parseTarNumber(block.subarray(148, 156), "header checksum");
  let calculatedChecksum = 0;
  for (let index = 0; index < block.length; index += 1) {
    calculatedChecksum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (recordedChecksum !== calculatedChecksum) fail("tar header checksum does not match");

  const magic = block.subarray(257, 263);
  const version = block.subarray(263, 265);
  const isPosixUstar = magic.equals(Buffer.from("ustar\0", "ascii")) && version.equals(Buffer.from("00", "ascii"));
  const isGnuUstar = magic.equals(Buffer.from("ustar ", "ascii")) && version[0] === 0x20 && version[1] === 0;
  if (!isPosixUstar && !isGnuUstar) fail("backup archive is not a supported ustar archive");
  const name = decodeTarText(block, 0, 100, "path");
  // POSIX ustar stores a path prefix here. GNU/BusyBox headers repurpose the
  // same bytes for other metadata, so they must not be interpreted as a path.
  const prefix = isPosixUstar ? decodeTarText(block, 345, 155, "path prefix") : "";
  const rawPath = prefix ? `${prefix}/${name}` : name;
  const typeByte = block[156];
  const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
  return {
    rawPath,
    type,
    size: parseTarNumber(block.subarray(124, 136), "file size"),
  };
}

function assertNoFileDirectoryCollisions(entries) {
  for (const [entryPath] of entries) {
    const segments = entryPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (entries.get(parent) === "file") fail("tar archive places a path below a regular file");
    }
  }
}

function isZlibError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && /^Z_/.test(String(error.code)));
}

async function inspectArchive(archive, expectedArchiveHash, manifest) {
  const compressed = createReadStream(archive);
  const archiveHash = createHash("sha256");
  let compressedBytes = 0;
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length;
      archiveHash.update(chunk);
      callback(null, chunk);
    },
  });
  const gunzip = createGunzip();
  compressed.once("error", (error) => hashingStream.destroy(error));
  hashingStream.once("error", (error) => gunzip.destroy(error));
  compressed.pipe(hashingStream).pipe(gunzip);

  const reader = new AsyncByteReader(gunzip);
  const archiveFiles = new Set();
  const archiveEntries = new Map();
  let workspaceBytes = 0;
  let zeroBlocks = 0;
  try {
    while (zeroBlocks < 2) {
      const block = await reader.readExact(TAR_BLOCK_BYTES);
      if (!block) fail("tar archive ended before its end marker");
      if (isZeroBlock(block)) {
        zeroBlocks += 1;
        continue;
      }
      if (zeroBlocks) fail("tar archive contains an entry after its first end marker");

      const header = parseTarHeader(block);
      const isRegularFile = header.type === "0";
      const isDirectory = header.type === "5";
      if (header.type === "1" || header.type === "2") fail("tar archive contains a link entry");
      if (!isRegularFile && !isDirectory) fail(`tar archive contains unsupported entry type ${JSON.stringify(header.type)}`);

      const relativePath = normalizeRelativePath(header.rawPath, "tar archive", {
        allowRoot: isDirectory,
        directory: isDirectory,
      });
      if (relativePath && archiveEntries.has(relativePath)) fail("tar archive contains a duplicate path");
      if (relativePath) archiveEntries.set(relativePath, isRegularFile ? "file" : "directory");

      if (isDirectory) {
        if (header.size !== 0) fail("tar directory entry has unexpected content");
        continue;
      }

      const expectedFileHash = manifest.get(relativePath);
      if (!expectedFileHash) fail(`tar archive contains an unlisted file: ${relativePath}`);
      const fileHash = createHash("sha256");
      await reader.consume(header.size, (chunk) => fileHash.update(chunk));
      const paddingBytes = (TAR_BLOCK_BYTES - (header.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      await reader.consume(paddingBytes, (chunk) => {
        if (chunk.some((byte) => byte !== 0)) fail(`tar file padding is invalid: ${relativePath}`);
      });
      const actualFileHash = fileHash.digest("hex");
      if (actualFileHash !== expectedFileHash) fail(`file checksum does not match archive content: ${relativePath}`);
      archiveFiles.add(relativePath);
      if (relativePath === "workspace.json") workspaceBytes = header.size;
    }

    await reader.assertOnlyZerosRemain();
  } catch (error) {
    if (isZlibError(error)) fail("backup archive is not a valid gzip stream");
    throw error;
  } finally {
    await reader.close().catch(() => undefined);
    compressed.destroy();
    hashingStream.destroy();
    gunzip.destroy();
  }

  const actualArchiveHash = archiveHash.digest("hex");
  if (actualArchiveHash !== expectedArchiveHash) fail("backup archive checksum does not match");
  if (workspaceBytes <= 0) fail("archive workspace.json is empty");
  if (archiveFiles.size !== manifest.size) {
    const missing = [...manifest.keys()].find((entry) => !archiveFiles.has(entry));
    fail(`file manifest refers to a file missing from the archive${missing ? `: ${missing}` : ""}`);
  }
  assertNoFileDirectoryCollisions(archiveEntries);
  return { bytes: compressedBytes, sha256: actualArchiveHash, files: archiveFiles.size };
}

async function verifyBackup(archivePath) {
  const archive = path.resolve(archivePath);
  const archiveName = path.basename(archive);
  if (!/\.t(?:ar\.)?gz$/i.test(archiveName)) fail("backup archive must use .tgz or .tar.gz");
  const archiveStat = await stat(archive);
  if (!archiveStat.isFile() || archiveStat.size === 0) fail("backup archive is empty or is not a regular file");

  const checksumPath = `${archive}.sha256`;
  const manifestPath = `${archive}.files.sha256`;
  const [checksumText, manifestText] = await Promise.all([
    readFile(checksumPath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);
  const expectedHash = parseChecksumLine(checksumText, archiveName);
  const manifest = parseFileManifest(manifestText);
  const result = await inspectArchive(archive, expectedHash, manifest);
  return { archiveName, ...result };
}

const archiveArgument = process.argv[2];
if (!archiveArgument || process.argv.length > 3) {
  console.error("Usage: node scripts/verify-backup.mjs <backup.tgz>");
  process.exitCode = 2;
} else {
  try {
    const result = await verifyBackup(archiveArgument);
    console.log(`Backup verified: ${result.archiveName} (${result.bytes} bytes, ${result.files} files, sha256 ${result.sha256})`);
  } catch (error) {
    console.error(`Backup verification failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
