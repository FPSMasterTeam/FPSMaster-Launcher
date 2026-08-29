// Offline-mode player UUID, matching Java's
// `UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8))`:
// an MD5 name-based (version 3) UUID over the "OfflinePlayer:<name>" string.
// Vanilla servers running in offline mode derive the player UUID exactly this
// way, so launching with the same UUID keeps stats/playerdata consistent.
//
// MD5 is implemented locally (RFC 1321): the Web Crypto API does not expose MD5,
// and account creation must stay synchronous for the current account-store flow.

const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
  14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

// K[i] = floor(abs(sin(i + 1)) * 2^32), per RFC 1321.
const SINE_TABLE = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  SINE_TABLE[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x1_0000_0000);
}

function md5(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  const paddedLength = (((input.length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(input);
  buffer[input.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x1_0000_0000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const chunk = new Uint32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let j = 0; j < 16; j++) {
      chunk[j] = view.getUint32(offset + j * 4, true);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + SINE_TABLE[i] + chunk[g]) >>> 0;
      const shift = SHIFTS[i];
      a = d;
      d = c;
      c = b;
      b = (b + (((sum << shift) | (sum >>> (32 - shift))) >>> 0)) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const digest = new Uint8Array(16);
  const digestView = new DataView(digest.buffer);
  digestView.setUint32(0, a0, true);
  digestView.setUint32(4, b0, true);
  digestView.setUint32(8, c0, true);
  digestView.setUint32(12, d0, true);
  return digest;
}

export function createOfflineMinecraftUuid(username: string): string {
  const digest = md5(new TextEncoder().encode(`OfflinePlayer:${username}`));
  // Same bit twiddling as java.util.UUID.nameUUIDFromBytes.
  digest[6] = (digest[6] & 0x0f) | 0x30; // version 3 (name-based, MD5)
  digest[8] = (digest[8] & 0x3f) | 0x80; // IETF variant
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
