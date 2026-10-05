const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");

test("PowerShell 5.1 打包路径、文件头、版本和内容一致，版本包复制到下载目录", () => {
  const script = fs.readFileSync(path.join(root, "build-release.ps1"));
  assert.deepEqual([...script.subarray(0, 3)], [239, 187, 191]);
  const result = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "build-release.ps1")], { encoding: "utf8" }));
  const buffer = fs.readFileSync(result.zip);
  assert.deepEqual(fs.readFileSync(result.downloadZip), buffer);
  assert.equal(path.basename(result.downloadZip), "native-auto-space-v1.0.0.zip");
  let end = buffer.length - 22;
  while (buffer.readUInt32LE(end) !== 0x06054b50) end--;
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    assert.ok(!name.includes("\\") && !name.startsWith("/") && !name.includes(".."));
    assert.ok(!/^(?:tests|node_modules|dist|\.git)\//.test(name));
    names.push(name);
    const local = buffer.readUInt32LE(offset + 42);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const localNameLength = buffer.readUInt16LE(local + 26), localExtra = buffer.readUInt16LE(local + 28);
    assert.equal(buffer.subarray(local + 30, local + 30 + localNameLength).toString("utf8"), name);
    const start = local + 30 + localNameLength + localExtra;
    const compressed = buffer.subarray(start, start + size);
    const data = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    assert.deepEqual(data, fs.readFileSync(path.join(root, name)));
    if (name === "manifest.json") assert.equal(JSON.parse(data).version, "1.0.0");
    offset += 46 + nameLength + extra + comment;
  }
  for (const name of ["manifest.json", "background.js", "content.js", "shared.js", "options.html", "popup.html", "ui.js", "ui.css", "icons/icon-128.png", "LICENSE"]) assert.ok(names.includes(name));
  assert.equal(new Set(names).size, names.length);
});
