/**
 * Streaming ZIP writer (store + deflate), enough for "download this folder".
 *
 * Why hand-rolled: the plugin must not add a runtime dependency to the user's
 * profile, and `ctx.fs` has no directory/stream primitive to build on. The
 * format is small and frozen, so one careful writer beats an install step.
 *
 * Limits are explicit: no ZIP64 (4 GiB / 65535 entries), which the HTTP layer
 * turns into a readable error instead of a corrupt archive.
 *
 * @module dsh-file-manager/zip
 */
import { open } from 'node:fs/promises'
import { once } from 'node:events'
import { deflateRawSync } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_DESCRIPTOR = 0x08074b50
const SIG_CENTRAL = 0x02014b50
const SIG_END = 0x06054b50

const FLAG_DESCRIPTOR = 0x0008
const FLAG_UTF8 = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
const MAX32 = 0xffffffff

/** Suffixes whose files are worth trying to deflate when small. */
const COMPRESSIBLE = new Set([
  'c', 'cc', 'cfg', 'cjs', 'cmake', 'conf', 'cpp', 'cs', 'css', 'csv', 'dockerfile',
  'gitignore', 'gitattributes', 'go', 'gradle', 'h', 'hpp', 'htm', 'html', 'ini',
  'java', 'js', 'json', 'jsonl', 'jsx', 'kt', 'less', 'log', 'lua', 'm', 'makefile',
  'md', 'mjs', 'php', 'properties', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte',
  'svg', 'tex', 'toml', 'ts', 'tsv', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zsh',
])

/** In-memory deflate ceiling per entry (larger files stream stored instead). */
const DEFLATE_MAX_BYTES = 8 * 1024 * 1024

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/**
 * Update a running CRC32.
 * @param {Buffer} chunk bytes to fold in.
 * @param {number} [previous] the previous final CRC (omit on the first chunk).
 * @returns {number} the new final CRC as an unsigned 32-bit number.
 */
export function crc32(chunk, previous) {
  let crc = ((previous ?? 0) ^ 0xffffffff) >>> 0
  for (let i = 0; i < chunk.length; i++) {
    crc = (CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * MS-DOS date/time pair for a timestamp.
 * @param {number} milliseconds epoch milliseconds.
 * @returns {{ dosTime: number, dosDate: number }} the packed fields.
 */
function dosDateTime(milliseconds) {
  const date = new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now())
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { dosTime, dosDate }
}

/** Whether an entry name looks like text worth deflating. */
function looksTextual(name) {
  const base = name.split('/').pop() ?? name
  const dot = base.lastIndexOf('.')
  const suffix = dot === -1 ? base.toLowerCase() : base.slice(dot + 1).toLowerCase()
  return COMPRESSIBLE.has(suffix)
}

/** One central-directory record collected while streaming. */
class CentralRecord {
  constructor(name, flags, method, dosTime, dosDate, crc, compressedSize, size, offset, directory) {
    this.name = name
    this.flags = flags
    this.method = method
    this.dosTime = dosTime
    this.dosDate = dosDate
    this.crc = crc
    this.compressedSize = compressedSize
    this.size = size
    this.offset = offset
    this.directory = directory
  }
}

/**
 * Write one ZIP archive onto a byte sink (the HTTP response).
 */
export class ZipWriter {
  /**
   * @param {import('node:stream').Writable} out destination stream.
   */
  constructor(out) {
    this.out = out
    this.offset = 0
    this.records = []
    this.finished = false
  }

  /**
   * Write bytes, waiting for drain when the socket is backed up.
   * @param {Buffer} buffer bytes to emit.
   * @returns {Promise<void>} settles once the chunk is accepted.
   */
  async write(buffer) {
    this.offset += buffer.length
    if (this.offset > MAX32) throw new Error('zip archive exceeds the 4 GiB ZIP32 limit')
    if (!this.out.write(buffer)) await once(this.out, 'drain')
  }

  /**
   * Add one directory entry.
   * @param {string} name archive path, with or without the trailing slash.
   * @param {number} mtimeMs last modification timestamp.
   * @returns {Promise<void>} settles when the entry is written.
   */
  async addDirectory(name, mtimeMs) {
    const archiveName = name.endsWith('/') ? name : `${name}/`
    const { dosTime, dosDate } = dosDateTime(mtimeMs)
    const nameBytes = Buffer.from(archiveName, 'utf8')
    const flags = FLAG_UTF8
    const offset = this.offset
    await this.write(localHeader(flags, METHOD_STORE, dosTime, dosDate, 0, 0, 0, nameBytes))
    this.records.push(new CentralRecord(archiveName, flags, METHOD_STORE, dosTime, dosDate, 0, 0, 0, offset, true))
    this.assertCapacity()
  }

  /**
   * Add one file, deflating small text and streaming everything else.
   * @param {string} name archive path.
   * @param {string} absolutePath file on disk.
   * @param {{ size: number, mtimeMs: number }} info stat result for the file.
   * @returns {Promise<void>} settles when the entry is fully written.
   */
  async addFile(name, absolutePath, info) {
    if (info.size <= DEFLATE_MAX_BYTES && looksTextual(name)) {
      const handle = await open(absolutePath, 'r')
      try {
        const bytes = await handle.readFile()
        await this.addBuffer(name, bytes, info.mtimeMs, true)
      } finally {
        await handle.close()
      }
      return
    }
    await this.streamStored(name, absolutePath, info)
  }

  /**
   * Add one in-memory file.
   * @param {string} name archive path.
   * @param {Buffer} bytes content.
   * @param {number} mtimeMs last modification timestamp.
   * @param {boolean} compress whether to deflate.
   * @returns {Promise<void>} settles when the entry is written.
   */
  async addBuffer(name, bytes, mtimeMs, compress) {
    const { dosTime, dosDate } = dosDateTime(mtimeMs)
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(bytes)
    const payload = compress ? deflateRawSync(bytes, { level: 6 }) : bytes
    const method = compress ? METHOD_DEFLATE : METHOD_STORE
    const flags = FLAG_UTF8
    const offset = this.offset
    await this.write(localHeader(flags, method, dosTime, dosDate, crc, payload.length, bytes.length, nameBytes))
    await this.write(payload)
    this.records.push(new CentralRecord(name, flags, method, dosTime, dosDate, crc, payload.length, bytes.length, offset, false))
    this.assertCapacity()
  }

  /**
   * Stream one file with a data descriptor (size unknown up front).
   * @param {string} name archive path.
   * @param {string} absolutePath file on disk.
   * @param {{ size: number, mtimeMs: number }} info stat result for the file.
   * @returns {Promise<void>} settles when the entry is fully written.
   */
  async streamStored(name, absolutePath, info) {
    const { dosTime, dosDate } = dosDateTime(info.mtimeMs)
    const nameBytes = Buffer.from(name, 'utf8')
    const flags = FLAG_UTF8 | FLAG_DESCRIPTOR
    const offset = this.offset
    await this.write(localHeader(flags, METHOD_STORE, dosTime, dosDate, 0, 0, 0, nameBytes))
    const handle = await open(absolutePath, 'r')
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let crc = 0
    let size = 0
    try {
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        const chunk = buffer.subarray(0, bytesRead)
        crc = crc32(chunk, crc)
        size += bytesRead
        if (size > MAX32) throw new Error('zip entry exceeds the 4 GiB ZIP32 limit')
        await this.write(Buffer.from(chunk))
      }
    } finally {
      await handle.close()
    }
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0)
    descriptor.writeUInt32LE(crc, 4)
    descriptor.writeUInt32LE(size, 8)
    descriptor.writeUInt32LE(size, 12)
    await this.write(descriptor)
    this.records.push(new CentralRecord(name, flags, METHOD_STORE, dosTime, dosDate, crc, size, size, offset, false))
    this.assertCapacity()
  }

  /** Refuse archives ZIP32 cannot index. */
  assertCapacity() {
    if (this.records.length > 0xffff) throw new Error('zip archive exceeds the 65535 entry ZIP32 limit')
  }

  /**
   * Emit the central directory and the end record.
   * @returns {Promise<void>} settles when the archive tail is written.
   */
  async finish() {
    if (this.finished) return
    this.finished = true
    const start = this.offset
    for (const record of this.records) {
      const nameBytes = Buffer.from(record.name, 'utf8')
      const header = Buffer.alloc(46)
      header.writeUInt32LE(SIG_CENTRAL, 0)
      header.writeUInt16LE(20, 4)
      header.writeUInt16LE(20, 6)
      header.writeUInt16LE(record.flags, 8)
      header.writeUInt16LE(record.method, 10)
      header.writeUInt16LE(record.dosTime, 12)
      header.writeUInt16LE(record.dosDate, 14)
      header.writeUInt32LE(record.crc, 16)
      header.writeUInt32LE(record.compressedSize, 20)
      header.writeUInt32LE(record.size, 24)
      header.writeUInt16LE(nameBytes.length, 28)
      header.writeUInt16LE(0, 30)
      header.writeUInt16LE(0, 32)
      header.writeUInt16LE(0, 34)
      header.writeUInt16LE(0, 36)
      const external = record.directory ? ((0o040755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0
      header.writeUInt32LE(external, 38)
      header.writeUInt32LE(record.offset, 42)
      await this.write(header)
      await this.write(nameBytes)
    }
    const size = this.offset - start
    const end = Buffer.alloc(22)
    end.writeUInt32LE(SIG_END, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(this.records.length, 8)
    end.writeUInt16LE(this.records.length, 10)
    end.writeUInt32LE(size, 12)
    end.writeUInt32LE(start, 16)
    end.writeUInt16LE(0, 20)
    await this.write(end)
  }
}

/**
 * Build one local file header.
 * @param {number} flags general-purpose bit flag.
 * @param {number} method compression method.
 * @param {number} dosTime packed time.
 * @param {number} dosDate packed date.
 * @param {number} crc CRC32 (0 when a descriptor follows).
 * @param {number} compressedSize payload size (0 with a descriptor).
 * @param {number} size uncompressed size (0 with a descriptor).
 * @param {Buffer} nameBytes UTF-8 archive path.
 * @returns {Buffer} the 30-byte header plus the name.
 */
function localHeader(flags, method, dosTime, dosDate, crc, compressedSize, size, nameBytes) {
  const header = Buffer.alloc(30)
  header.writeUInt32LE(SIG_LOCAL, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(flags, 6)
  header.writeUInt16LE(method, 8)
  header.writeUInt16LE(dosTime, 10)
  header.writeUInt16LE(dosDate, 12)
  header.writeUInt32LE(crc, 14)
  header.writeUInt32LE(compressedSize, 18)
  header.writeUInt32LE(size, 22)
  header.writeUInt16LE(nameBytes.length, 26)
  header.writeUInt16LE(0, 28)
  return Buffer.concat([header, nameBytes])
}
