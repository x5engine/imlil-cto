/**
 * Tiny xxh3-64 for chunk hashing.
 * Pure JS, no native deps. Uses BitInt for 64-bit arithmetic.
 * Collision risk is ~1/2^64 — fine for ~1M chunks.
 */

// xxh3 constants (scrambled)
const PRIME64_1 = 0x9E3779B185EBCA87n;
const PRIME64_2 = 0xC2B2AE3D27D4EB4Fn;
const PRIME64_3 = 0x165667B19E3779F9n;
const PRIME64_4 = 0x85EBCA77C2B2AE63n;
const PRIME64_5 = 0x27D4EB2F165667C5n;

function rotl64(x, r) {
  return (x << BigInt(r)) | (x >> BigInt(64n - BigInt(r)));
}

function mul128(a, b) {
  // a and b are 64-bit BigInts; return low 64 bits of their product
  const result = a * b;
  return result & 0xFFFFFFFFFFFFFFFFn;
}

function avalanche(h) {
  h ^= h >> 33n;
  h = mul128(h, PRIME64_2);
  h ^= h >> 29n;
  h = mul128(h, PRIME64_3);
  h ^= h >> 32n;
  return h;
}

function get64(buf, offset) {
  let val = 0n;
  for (let i = 0; i < 8; i++) {
    val |= BigInt(buf[offset + i]) << BigInt(i * 8);
  }
  return val;
}

export function xxh3(buf) {
  const len = buf.length;
  let h;

  if (len >= 32) {
    let acc1 = PRIME64_1 + PRIME64_2;
    let acc2 = PRIME64_2;
    let acc3 = 0n;
    let acc4 = -PRIME64_1;
    let acc5 = BigInt(len) * PRIME64_1;

    // Process 32-byte stripes
    let i = 0;
    const limit = len - 32;
    while (i <= limit) {
      acc1 += get64(buf, i) * PRIME64_2;
      acc1 = rotl64(acc1, 31);
      acc1 *= PRIME64_1;

      acc2 += get64(buf, i + 8) * PRIME64_2;
      acc2 = rotl64(acc2, 31);
      acc2 *= PRIME64_1;

      acc3 += get64(buf, i + 16) * PRIME64_2;
      acc3 = rotl64(acc3, 31);
      acc3 *= PRIME64_1;

      acc4 += get64(buf, i + 24) * PRIME64_2;
      acc4 = rotl64(acc4, 31);
      acc4 *= PRIME64_1;

      i += 32;
    }

    h = acc1 ^ acc2 ^ acc3 ^ acc4 ^ acc5;

    // Remaining bytes after last full stripe
    i = limit + 32;
    while (i < len) {
      const lane = get64(buf.slice(i));  // simplified
      h ^= lane * PRIME64_1;
      h = rotl64(h, 27) * PRIME64_1 + PRIME64_4;
      i += 8;
    }
  } else {
    // small input (< 32 bytes)
    h = BigInt(len) * PRIME64_5;
  }

  // Process remaining 1-7 bytes (or full small input)
  let i = len - (len >= 32 ? len % 8 : len % 8);
  while (i < len) {
    let lane = BigInt(buf[i]);
    h ^= lane * PRIME64_1;
    h = rotl64(h, 11) * PRIME64_2;
    i++;
  }

  return avalanche(h).toString(16).padStart(16, '0');
}

export function hashText(text) {
  const encoder = new TextEncoder();
  return xxh3(encoder.encode(text));
}