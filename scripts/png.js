'use strict';

/**
 * A minimal PNG encoder, so the project stays dependency-free.
 *
 * Shared by scripts/make-sample.js and test/renderer.js — the latter needs to
 * produce a fixture whose exact pixel values it can then assert on after a
 * round trip through Chromium's decoder.
 */

const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Buffer|Uint8Array} rgba width*height*4 bytes, 8 bits per channel
 * @returns {Buffer} a complete PNG
 */
function encodePNG(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePNG: expected ${width * height * 4} bytes, got ${rgba.length}`);
  }

  // Raw scanlines: one filter byte (0 = none) followed by the row's pixels.
  const raw = Buffer.alloc(height * (1 + width * 4));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let i = 0; i < width * 4; i++) raw[p++] = rgba[y * width * 4 + i];
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // bytes 10-12: compression, filter, interlace — all 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The other way: an 8-bit, non-interlaced PNG of any colour type, as raw
 * samples. For the scripts that change a render in plain node
 * (scripts/degrade.js); the lab itself decodes through Chromium.
 *
 * @param {Buffer|Uint8Array} bytes a complete PNG file
 * @returns {{width: number, height: number, channels: number, data: Buffer}}
 *   `data` is height*width*channels bytes, as stored: 1 gray, 2 gray+alpha,
 *   3 RGB, 4 RGBA
 */
function decodePNG(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8, width, height, channels;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('latin1', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = d.readUInt32BE(0); height = d.readUInt32BE(4);
      channels = { 0: 1, 4: 2, 2: 3, 6: 4 }[d[9]];
      if (d[8] !== 8 || !channels || d[12] !== 0) throw new Error('decodePNG: only 8-bit, non-palette, non-interlaced');
    } else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels, out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

module.exports = { encodePNG, decodePNG };

/* ------------------------------------------------------------------ */
/* reading what a PNG says about its own colour encoding               */
/* ------------------------------------------------------------------ */

/** gAMA within this tolerance of a target counts as that target. */
const GAMMA_TOLERANCE = 500; // in units of gamma * 100000

/**
 * Read the colour-declaring chunks from a PNG, without decompressing anything.
 *
 * PNG can declare its encoding four ways, and most files declare nothing at
 * all — in which case every decoder in existence assumes sRGB, and so do we.
 * The point of reading them is the case that assumption gets wrong: a file
 * that says `gAMA 1.0` holds LINEAR samples, and treating those as sRGB
 * applies a curve that was never there.
 *
 * Precedence follows the specification: cICP, then iCCP, then sRGB, then gAMA.
 *
 * @param {Buffer|Uint8Array} bytes a complete PNG file
 * @returns {{declared: 'srgb'|'linear'|'icc'|'undeclared',
 *            gamma: number|null, chunks: string[], detail: string}}
 */
function readPngColour(bytes) {
  const unknown = { declared: 'undeclared', gamma: null, chunks: [], detail: 'no colour chunks' };
  if (bytes.length < 8) return unknown;

  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== signature[i]) return unknown;

  const view = new DataView(
    bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);

  const chunks = [];
  let gamma = null;
  let hasSrgb = false;
  let iccName = null;
  let cicp = null;

  let offset = 8;
  // Colour chunks all precede IDAT, so there is no need to walk the image data.
  while (offset + 8 <= view.byteLength) {
    const length = view.getUint32(offset);
    let type = '';
    for (let i = 0; i < 4; i++) type += String.fromCharCode(view.getUint8(offset + 4 + i));
    const dataAt = offset + 8;
    if (dataAt + length > view.byteLength) break;

    if (type === 'IDAT' || type === 'IEND') break;
    chunks.push(type);

    if (type === 'gAMA' && length === 4) {
      gamma = view.getUint32(dataAt);
    } else if (type === 'sRGB') {
      hasSrgb = true;
    } else if (type === 'iCCP') {
      let name = '';
      for (let i = 0; i < Math.min(length, 79); i++) {
        const c = view.getUint8(dataAt + i);
        if (c === 0) break;
        name += String.fromCharCode(c);
      }
      iccName = name;
    } else if (type === 'cICP' && length >= 4) {
      cicp = { primaries: view.getUint8(dataAt), transfer: view.getUint8(dataAt + 1) };
    }

    offset = dataAt + length + 4; // + CRC
  }

  if (cicp) {
    // ITU-T H.273 transfer characteristic 8 is linear; 13 is sRGB.
    const declared = cicp.transfer === 8 ? 'linear' : cicp.transfer === 13 ? 'srgb' : 'icc';
    return { declared, gamma, chunks, detail: `cICP transfer=${cicp.transfer}` };
  }
  if (iccName !== null) {
    // Parsing an ICC profile's transfer curve is out of scope; report that one
    // is present rather than guessing at it.
    return { declared: 'icc', gamma, chunks, detail: `iCCP "${iccName}"` };
  }
  if (hasSrgb) {
    return { declared: 'srgb', gamma, chunks, detail: 'sRGB chunk' };
  }
  if (gamma !== null) {
    if (Math.abs(gamma - 100000) <= GAMMA_TOLERANCE) {
      return { declared: 'linear', gamma, chunks, detail: `gAMA ${gamma} (gamma 1.0)` };
    }
    if (Math.abs(gamma - 45455) <= GAMMA_TOLERANCE) {
      return { declared: 'srgb', gamma, chunks, detail: `gAMA ${gamma} (gamma 1/2.2)` };
    }
    return { declared: 'icc', gamma, chunks, detail: `gAMA ${gamma} (gamma ${(gamma / 100000).toFixed(4)})` };
  }
  return { ...unknown, chunks };
}

module.exports.readPngColour = readPngColour;
