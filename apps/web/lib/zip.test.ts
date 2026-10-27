import { inflateRawSync } from "node:zlib";
import { expect, test } from "vitest";
import { crc32, zipName, zipStream } from "./zip";

/** Reads every entry back with the central directory, the way an unzip tool does. */
function unzip(bytes: Buffer): Array<{ name: string; data: Buffer }> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16);
  const out: Array<{ name: string; data: Buffer }> = [];
  let at = start;
  for (let i = 0; i < count; i += 1) {
    const method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16), compressed = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28), local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const body = bytes.subarray(dataStart, dataStart + compressed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(crc32(data)).toBe(crc);
    out.push({ name, data });
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return out;
}

test("a zip carries Chinese names and both compressed and stored entries, and skips an entry that cannot be read", async () => {
  const text = Buffer.from("一份笔记\n".repeat(200), "utf8");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const stream = zipStream([{ name: "研究者/10-19 文献综述/综述.md", read: () => text }, { name: "图/a.png", read: () => png }, { name: "gone.txt", read: () => undefined }]);
  const bytes = Buffer.from(await new Response(stream).arrayBuffer());
  const entries = unzip(bytes);
  expect(entries.map((entry) => entry.name)).toEqual(["研究者/10-19 文献综述/综述.md", "图/a.png"]);
  expect(entries[0]!.data.equals(text)).toBe(true);
  expect(entries[1]!.data.equals(png)).toBe(true);
});

test("an archive path never climbs out or starts at the root", () => {
  expect(zipName("../../etc/passwd")).toBe("etc/passwd");
  expect(zipName("\\a\\b.txt")).toBe("a/b.txt");
  expect(zipName("")).toBe("file");
  expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
});
