/**
 * Float frames as Portable Float Maps: the file form of what rr's analysis
 * camera hands the package in memory.
 *
 * PFM is the simplest format that holds linear light losslessly: a text
 * header -- `PF` (three channels) or `Pf` (one), the size, and a scale whose
 * sign is the byte order -- then float32 samples, rows bottom-up. pt-lab
 * writes it (`npm run generate -- --float`), and cv-lab's host reads it for
 * `frame()`. The package itself only ever sees a `Frame`.
 */

/**
 * A float frame, rows top-down.
 * @typedef {import('./types.js').Frame} Frame
 */

/**
 * A PFM file's bytes as a frame, rows turned top-down. Refuses anything that
 * is not exactly a header and width x height x channels samples.
 * @param {Uint8Array} bytes
 * @returns {Frame}
 */
function decodePfm(bytes) {
  // Three whitespace-terminated tokens after the magic, the last followed by
  // exactly one whitespace byte; the samples start after it.
  const tokens = [];
  let at = 0;
  while (tokens.length < 4) {
    while (at < bytes.length && isSpace(bytes[at])) at++;
    const start = at;
    while (at < bytes.length && !isSpace(bytes[at])) at++;
    if (at >= bytes.length) throw new Error('PFM: the header ends before its four fields do');
    tokens.push(String.fromCharCode(...bytes.subarray(start, at)));
  }
  at++;
  const [magic, w, h, s] = tokens;
  const channels = magic === 'PF' ? 3 : magic === 'Pf' ? 1 : 0;
  if (!channels) throw new Error(`PFM: starts "${magic.slice(0, 8)}", not PF or Pf`);
  const width = Number(w), height = Number(h), scale = Number(s);
  if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) {
    throw new Error(`PFM: size ${w} x ${h} is not two positive integers`);
  }
  if (!(Number.isFinite(scale) && scale !== 0)) throw new Error(`PFM: scale "${s}" is not a non-zero number`);
  const count = width * height * channels;
  if (bytes.length - at !== count * 4) {
    throw new Error(`PFM: ${width} x ${height} x ${channels} needs ${count * 4} bytes of samples, the file has ${bytes.length - at}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, count * 4);
  const little = scale < 0;
  const row = width * channels;
  const data = new Float32Array(count);
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * row;
    for (let i = 0; i < row; i++) data[y * row + i] = view.getFloat32((from + i) * 4, little);
  }
  return { width, height, channels, data };
}

/**
 * A frame as PFM bytes, little-endian, rows bottom-up. Alpha, if any, is not
 * written: PFM has no place for it.
 * @param {Frame} frame
 * @returns {Uint8Array}
 */
function encodePfm({ width, height, channels, data }) {
  const out = channels === 1 ? 1 : 3;
  const header = new TextEncoder().encode(`${out === 3 ? 'PF' : 'Pf'}\n${width} ${height}\n-1.0\n`);
  const bytes = new Uint8Array(header.length + width * height * out * 4);
  bytes.set(header);
  const view = new DataView(bytes.buffer, header.length);
  let k = 0;
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < out; c++) view.setFloat32(4 * k++, data[(y * width + x) * channels + c], true);
    }
  }
  return bytes;
}

const isSpace = (b) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

export { decodePfm, encodePfm };
