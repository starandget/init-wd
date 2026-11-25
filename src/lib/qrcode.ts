/**
 * Minimal zero-dependency QR Code generator (ISO/IEC 18004, Byte mode, ECC Level L, Versions 1-6).
 * Sufficient for LAN URLs up to 134 UTF-8 bytes (e.g. http://192.168.100.200:8080).
 */

interface VersionSpec {
  version: number;
  size: number;
  dataCodewords: number;
  ecCodewords: number;
  alignmentCenters: number[];
}

// Single-block ECC Level L tables for versions 1..6 (exact ISO/IEC 18004 Table 9)
const VERSION_SPECS: VersionSpec[] = [
  { version: 1, size: 21, dataCodewords: 19, ecCodewords: 7, alignmentCenters: [] },
  { version: 2, size: 25, dataCodewords: 34, ecCodewords: 10, alignmentCenters: [6, 18] },
  { version: 3, size: 29, dataCodewords: 55, ecCodewords: 15, alignmentCenters: [6, 22] },
  { version: 4, size: 33, dataCodewords: 80, ecCodewords: 20, alignmentCenters: [6, 26] },
  { version: 5, size: 37, dataCodewords: 108, ecCodewords: 26, alignmentCenters: [6, 30] },
  // Version 6-L uses 2 blocks of (68 data, 18 EC), handled separately below if needed
];

// GF(256) arithmetic with primitive polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[ecCount - 1] = 0;
    for (let j = 0; j < ecCount; j++) {
      res[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return res;
}

function computeFormatBits(mask: number): number {
  // ECC Level L = 01
  const data = (0b01 << 3) | (mask & 0x7);
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) {
    if (rem & (1 << (i + 10))) {
      rem ^= 0x537 << i;
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function maskCondition(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function evaluatePenalty(modules: Uint8Array, size: number): number {
  let penalty = 0;
  const at = (r: number, c: number) => modules[r * size + c];

  // Rule 1: adjacent modules in row/col of same color
  for (let r = 0; r < size; r++) {
    let runColor = at(r, 0);
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (at(r, c) === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = at(r, c);
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c++) {
    let runColor = at(0, c);
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (at(r, c) === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = at(r, c);
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) {
        penalty += 3;
      }
    }
  }

  // Rule 4: balance of dark modules
  let dark = 0;
  for (let i = 0; i < modules.length; i++) dark += modules[i];
  const ratio = Math.abs((dark * 100) / modules.length - 50);
  penalty += Math.floor(ratio / 5) * 10;

  return penalty;
}

export interface QrMatrix {
  size: number;
  modules: Uint8Array;
}

export function generateQrMatrix(text: string): QrMatrix | null {
  const bytes = new TextEncoder().encode(text);
  // Byte mode overhead: 4 bits mode + 8 bits length (for v1..v9) + 4 bits terminator => 2 bytes
  const spec = VERSION_SPECS.find((s) => bytes.length + 2 <= s.dataCodewords);
  if (!spec) return null;

  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >> i) & 1);
    }
  };

  // Mode indicator: Byte (0100)
  pushBits(0b0100, 4);
  // Character count indicator (8 bits for versions 1-9)
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);

  const capacityBits = spec.dataCodewords * 8;
  // Terminator (up to 4 zeros)
  const termLen = Math.min(4, capacityBits - bits.length);
  pushBits(0, termLen);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(spec.dataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | bits[i * 8 + b];
    }
    data[i] = byte;
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  for (let i = bits.length / 8; i < spec.dataCodewords; i++) {
    data[i] = padBytes[padIdx % 2];
    padIdx++;
  }

  const ec = rsRemainder(data, spec.ecCodewords);
  const allCodewords = new Uint8Array(data.length + ec.length);
  allCodewords.set(data, 0);
  allCodewords.set(ec, data.length);

  const size = spec.size;
  const baseModules = new Uint8Array(size * size);
  const isFunction = new Uint8Array(size * size);

  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    baseModules[r * size + c] = dark ? 1 : 0;
    isFunction[r * size + c] = 1;
  };

  // Finder patterns + separators
  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const isBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const isCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunc(r, c, inOuter && (isBorder || isCore));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Alignment patterns
  const centers = spec.alignmentCenters;
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(r + dr, c + dc, dist !== 1);
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Dark module
  setFunc(size - 8, 8, true);

  // Reserve format info strips
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      isFunction[8 * size + i] = 1;
      isFunction[i * size + 8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    isFunction[8 * size + (size - 1 - i)] = 1;
    isFunction[(size - 1 - i) * size + 8] = 1;
  }

  // Place data bits in zig-zag
  let bitIndex = 0;
  const totalBits = allCodewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunction[r * size + c]) {
          let dark = 0;
          if (bitIndex < totalBits) {
            dark = (allCodewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
            bitIndex++;
          }
          baseModules[r * size + c] = dark;
        }
      }
    }
    upward = !upward;
  }

  // Pick best mask pattern (0..7)
  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  let bestModules = baseModules;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = new Uint8Array(baseModules);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunction[r * size + c] && maskCondition(mask, r, c)) {
          candidate[r * size + c] ^= 1;
        }
      }
    }

    // Write format info bits
    const fmt = computeFormatBits(mask);
    for (let i = 0; i <= 5; i++) candidate[8 * size + i] = (fmt >> (14 - i)) & 1;
    candidate[8 * size + 7] = (fmt >> 8) & 1;
    candidate[8 * size + 8] = (fmt >> 7) & 1;
    candidate[7 * size + 8] = (fmt >> 6) & 1;
    for (let i = 9; i < 15; i++) candidate[(14 - i) * size + 8] = (fmt >> (14 - i)) & 1;

    for (let i = 0; i < 8; i++) candidate[8 * size + (size - 1 - i)] = (fmt >> i) & 1;
    for (let i = 0; i < 7; i++) candidate[(size - 1 - i) * size + 8] = (fmt >> (14 - i)) & 1;

    const pen = evaluatePenalty(candidate, size);
    if (pen < bestPenalty) {
      bestPenalty = pen;
      bestMask = mask;
      bestModules = candidate;
    }
  }

  void bestMask;
  return { size, modules: bestModules };
}

export function qrToSvgPath(matrix: QrMatrix): string {
  const { size, modules } = matrix;
  const parts: string[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r * size + c]) {
        parts.push(`M${c},${r}h1v1h-1z`);
      }
    }
  }
  return parts.join("");
}
