import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(projectRoot, "scripts", "verify-backup.mjs");
const TAR_BLOCK_BYTES = 512;

interface TarEntry {
  name: string;
  type?: "0" | "2" | "5";
  content?: Uint8Array | string;
  linkName?: string;
}

interface ManifestEntry {
  path: string;
  sha256: string;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeTarText(header: Buffer, value: string, offset: number, length: number): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length >= length) throw new Error(`tar test field is too long: ${value}`);
  encoded.copy(header, offset);
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  if (encoded.length !== length) throw new Error(`tar test number is too large: ${value}`);
  header.write(encoded, offset, length, "ascii");
}

function tarHeader(entry: TarEntry, content: Buffer, format: "posix" | "gnu"): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  writeTarText(header, entry.name, 0, 100);
  writeTarOctal(header, entry.type === "5" ? 0o755 : 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, content.length, 124, 12);
  writeTarOctal(header, 1_700_000_000, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = (entry.type ?? "0").charCodeAt(0);
  if (entry.linkName) writeTarText(header, entry.linkName, 157, 100);
  if (format === "gnu") {
    header.write("ustar ", 257, 6, "ascii");
    header[263] = 0x20;
    header[264] = 0;
  } else {
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
  }
  writeTarText(header, "root", 265, 32);
  writeTarText(header, "root", 297, 32);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function createTarGzip(entries: TarEntry[], format: "posix" | "gnu" = "posix"): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    blocks.push(tarHeader(entry, content, format), content);
    const padding = (TAR_BLOCK_BYTES - (content.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function regularManifest(entries: TarEntry[]): ManifestEntry[] {
  return entries
    .filter((entry) => (entry.type ?? "0") === "0")
    .map((entry) => ({
      path: entry.name.replace(/^\.\//, ""),
      sha256: sha256(Buffer.from(entry.content ?? "")),
    }));
}

async function writeBackupSet(
  directory: string,
  name: string,
  archiveBytes: Uint8Array,
  manifest: ManifestEntry[],
): Promise<string> {
  const archive = path.join(directory, name);
  await writeFile(archive, archiveBytes);
  await writeFile(`${archive}.sha256`, `${sha256(archiveBytes)}  /backup/${name}\n`, "utf8");
  await writeFile(
    `${archive}.files.sha256`,
    `${manifest.map((entry) => `${entry.sha256}  ./${entry.path}`).join("\n")}\n`,
    "utf8",
  );
  return archive;
}

function runVerifier(archive: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [verifier, archive], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("backup verifier streams a real tar.gz and checks every regular file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "finale-backup-test-"));
  const entries: TarEntry[] = [
    { name: "./", type: "5" },
    { name: "./uploads/", type: "5" },
    { name: "./workspace.json", content: "{\"version\":1}\n" },
    { name: "./uploads/example.pdf", content: "%PDF-1.4 deterministic fixture" },
  ];
  try {
    // Alpine BusyBox, used by the Compose backup command, emits GNU-flavoured
    // ustar magic. Other cases exercise the POSIX ustar variant as well.
    const archive = await writeBackupSet(directory, "finale-data-valid.tgz", createTarGzip(entries, "gnu"), regularManifest(entries));
    const result = await runVerifier(archive);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Backup verified:/);
    assert.match(result.stdout, /2 files/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backup verifier rejects a fake tgz even when its sidecars agree", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "finale-backup-test-"));
  try {
    const fake = Buffer.from("this is not gzip or tar", "utf8");
    const archive = await writeBackupSet(directory, "finale-data-fake.tgz", fake, [
      { path: "workspace.json", sha256: sha256("{\"version\":1}\n") },
    ]);
    const result = await runVerifier(archive);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not a valid gzip stream/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backup verifier detects archive content that no longer matches the manifest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "finale-backup-test-"));
  const originalEntries: TarEntry[] = [
    { name: "./workspace.json", content: "{\"version\":1}\n" },
    { name: "./uploads/example.pdf", content: "%PDF-original" },
  ];
  const changedEntries: TarEntry[] = [
    originalEntries[0]!,
    { name: "./uploads/example.pdf", content: "%PDF-tampered" },
  ];
  try {
    // The outer archive checksum is recomputed for the changed archive. Only
    // an actual per-file tar inspection can detect that its manifest is stale.
    const archive = await writeBackupSet(
      directory,
      "finale-data-tampered.tgz",
      createTarGzip(changedEntries),
      regularManifest(originalEntries),
    );
    const result = await runVerifier(archive);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /file checksum does not match archive content: uploads\/example\.pdf/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backup verifier requires an exact manifest file set and a non-empty workspace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "finale-backup-test-"));
  try {
    const entries: TarEntry[] = [{ name: "./workspace.json", content: "{\"version\":1}\n" }];
    const extraManifest = [...regularManifest(entries), { path: "uploads/missing.pdf", sha256: sha256("missing") }];
    const missingArchive = await writeBackupSet(directory, "finale-data-missing.tgz", createTarGzip(entries), extraManifest);
    const missing = await runVerifier(missingArchive);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /file missing from the archive: uploads\/missing\.pdf/);

    const emptyEntries: TarEntry[] = [{ name: "./workspace.json", content: "" }];
    const emptyArchive = await writeBackupSet(directory, "finale-data-empty.tgz", createTarGzip(emptyEntries), regularManifest(emptyEntries));
    const empty = await runVerifier(emptyArchive);
    assert.equal(empty.code, 1);
    assert.match(empty.stderr, /workspace\.json is empty/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backup verifier rejects unsafe paths and link entries", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "finale-backup-test-"));
  try {
    const unsafeEntries: TarEntry[] = [
      { name: "./workspace.json", content: "{\"version\":1}\n" },
      { name: "../escape.txt", content: "escape" },
    ];
    const unsafeArchive = await writeBackupSet(
      directory,
      "finale-data-unsafe.tgz",
      createTarGzip(unsafeEntries),
      regularManifest(unsafeEntries.filter((entry) => !entry.name.includes(".."))),
    );
    const unsafe = await runVerifier(unsafeArchive);
    assert.equal(unsafe.code, 1);
    assert.match(unsafe.stderr, /tar archive contains an unsafe path/);

    const linkEntries: TarEntry[] = [
      { name: "./workspace.json", content: "{\"version\":1}\n" },
      { name: "./uploads/alias.pdf", type: "2", linkName: "../../outside" },
    ];
    const linkArchive = await writeBackupSet(directory, "finale-data-link.tgz", createTarGzip(linkEntries), regularManifest(linkEntries));
    const link = await runVerifier(linkArchive);
    assert.equal(link.code, 1);
    assert.match(link.stderr, /contains a link entry/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backup documentation reuses the Compose-managed volume and keeps integrity gates", async () => {
  const [readme, compose] = await Promise.all([
    readFile(path.join(projectRoot, "README.md"), "utf8"),
    readFile(path.join(projectRoot, "docker-compose.yml"), "utf8"),
  ]);
  assert.match(compose, /init-data:[\s\S]*?- finale-data:\/data/);
  assert.match(readme, /docker compose run --rm --no-deps[\s\S]{0,500}init-data/);
  assert.doesNotMatch(readme, /^[ \t]*docker run[^\n]*-v finale-data:\/data/m);
  assert.match(readme, /verify-backup\.mjs/);
  assert.match(readme, /\.files\.sha256/);
  assert.match(readme, /tar -tzf/);
  assert.match(readme, /FINALE_BACKUP_DIR/);
  assert.doesNotMatch(readme, /mkdir -p backups/);

  const restoreSection = readme.slice(readme.indexOf("### 恢复"), readme.indexOf("## API"));
  const stagedExtraction = restoreSection.indexOf("tar -xzf \"$archive\" -C \"$staging\"");
  const stagedVerification = restoreSection.indexOf("sha256sum -c \"$archive.files.sha256\"");
  const destructiveReplacement = restoreSection.indexOf("find /data -mindepth 1");
  assert.ok(stagedExtraction >= 0, "restore must extract into staging");
  assert.ok(stagedVerification > stagedExtraction, "restore must verify staged files after extraction");
  assert.ok(destructiveReplacement > stagedVerification, "restore must not replace live data before staged verification passes");
});
