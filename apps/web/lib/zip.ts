import { deflateRawSync } from "node:zlib";

/**
 * A zip archive written as a stream (2026-10-19, the assistant's output folder): one entry's bytes are held at a time, compressed with
 * DEFLATE when that makes them smaller and stored otherwise, names in UTF-8 (general-purpose bit 11) so Chinese file names survive. No
 * zip64: the caller keeps the archive well under 4 GB and 65 535 entries.
 */
export type ZipEntry = { name: string; read: () => Buffer | undefined; modified?: Date };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date, as the format keeps them (two-second resolution, years from 1980). */
function dosTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getFullYear());
  return { time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate() };
}

/** A name as an archive path: forward slashes, no leading slash or `..` segment, never empty. */
export function zipName(name: string): string {
  const parts = name.replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "..");
  return parts.join("/") || "file";
}

export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  const central: Buffer[] = [];
  let offset = 0;
  let index = 0;
  let count = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      // One entry per pull, so a large archive never sits in memory whole.
      while (index < entries.length) {
        const entry = entries[index++]!;
        const raw = entry.read();
        if (!raw) continue;
        const name = Buffer.from(zipName(entry.name), "utf8");
        const deflated = deflateRawSync(raw);
        const stored = deflated.length >= raw.length;
        const body = stored ? raw : deflated;
        const crc = crc32(raw);
        const { time, date } = dosTime(entry.modified ?? new Date());
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8);
        header.writeUInt16LE(stored ? 0 : 8, 10); header.writeUInt16LE(time, 12); header.writeUInt16LE(date, 14);
        header.writeUInt32LE(crc, 16); header.writeUInt32LE(body.length, 20); header.writeUInt32LE(raw.length, 24);
        header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
        central.push(header, name);
        offset += local.length + name.length + body.length;
        count += 1;
        controller.enqueue(new Uint8Array(Buffer.concat([local, name, body])));
        return;
      }
      const directory = Buffer.concat(central);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
      end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
      controller.enqueue(new Uint8Array(Buffer.concat([directory, end])));
      controller.close();
    }
  });
}
