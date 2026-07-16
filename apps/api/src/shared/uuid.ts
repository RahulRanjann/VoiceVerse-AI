import { randomBytes } from 'node:crypto';

let lastTimestamp = 0;
let sequence = 0;

/**
 * Generates a process-monotonic RFC 9562 UUIDv7. The timestamp prefix keeps
 * PostgreSQL indexes append-friendly while cryptographic random bits preserve
 * collision resistance across processes.
 */
export function uuidv7(now = Date.now()): string {
  let timestamp = Math.max(now, lastTimestamp);
  if (timestamp === lastTimestamp) {
    sequence = (sequence + 1) & 0x0fff;
    if (sequence === 0) timestamp += 1;
  } else {
    sequence = randomBytes(2).readUInt16BE(0) & 0x0fff;
  }
  lastTimestamp = timestamp;

  const bytes = randomBytes(16);
  bytes.writeUIntBE(timestamp, 0, 6);
  bytes[6] = 0x70 | ((sequence >>> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
