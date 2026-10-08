/**
 * The package's own transcendental functions, so a result's bits do not
 * depend on the JavaScript engine (design-lab-model.md §5, rule 3b).
 *
 * ECMAScript leaves `Math.sin`, `atan2`, `log` and the rest
 * "implementation-approximated", and engines take it up: over 200,000
 * inputs Chrome 154's V8 and Node 22's differ on 3-18% of every one of them,
 * and Firefox differs from both, `hypot` included ("A fortieth"). One bit is
 * a different hash. What the language does pin down is `+ - * /` and
 * `Math.sqrt` -- IEEE 754 binary64, round to nearest, no fused
 * multiply-add -- so everything below is built from those alone, and returns
 * the same bits in every engine. It is the same move the C made with
 * `cv_atan2` and `cv_len2` (`native/kernels.h`), and `atan2` here is that
 * function, operation for operation, so where the C and the JavaScript
 * reach the same angle they agree on purpose.
 *
 * Accuracy is secondary and stated per function: what these exist for is
 * agreement. Each is within a few units in the last place of the true value
 * over the ranges this package uses, which `test/math.js` checks against the
 * engine's own.
 *
 * Not here, on purpose: the render plan in `gapsweep.js`'s `orbitViews`
 * keeps the engine's `Math`. It places a renderer's camera rather than
 * measuring anything, it is recorded in `shots.json`, and every existing run
 * is checked against those bytes.
 */

/** Length of (a, b): squared first, which cannot overflow at the scales here. */
export function len2(a, b) { return Math.sqrt(a * a + b * b); }

/** Length of (a, b, c). */
export function len3(a, b, c) { return Math.sqrt(a * a + b * b + c * c); }

/* tan(15 deg), sqrt(3), pi/6, pi/2: as `native/kernels.c` writes them. */
const TAN_15 = 0.26794919243112270647;
const SQRT_3 = 1.73205080756887729353;
const PI_6 = 0.52359877559829887308;
const PI_2 = 1.57079632679489661923;
const PI = 3.14159265358979323846;

/* (-1)^k / (2k+1), highest power first: cv_atan2's atan_series. */
const ATAN = [1 / 25, -1 / 23, 1 / 21, -1 / 19, 1 / 17, -1 / 15, 1 / 13, -1 / 11, 1 / 9, -1 / 7, 1 / 5, -1 / 3, 1];

function atanSeries(w) {
  const u = w * w;
  let p = ATAN[0];
  for (let i = 1; i < ATAN.length; i++) p = p * u + ATAN[i];
  return w * p;
}

function atanUnit(z) {
  if (z <= TAN_15) return atanSeries(z);
  return PI_6 + atanSeries((z * SQRT_3 - 1) / (z + SQRT_3));
}

/**
 * atan2 in radians over (-pi, pi], within a few ULP: `cv_atan2`, the same
 * operations in the same order. Like it, a negative zero `y` gives +0.
 */
export function atan2(y, x) {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x), ay = Math.abs(y);
  let a = ax >= ay ? atanUnit(ay / ax) : PI_2 - atanUnit(ax / ay);
  if (x < 0) a = PI - a;
  if (y < 0) a = -a;
  return a;
}

/** asin, from atan2: within a few ULP over [-1, 1]; NaN outside it. */
export function asin(x) { return atan2(x, Math.sqrt((1 - x) * (1 + x))); }

/** acos, from atan2: within a few ULP over [-1, 1]; NaN outside it. */
export function acos(x) { return atan2(Math.sqrt((1 - x) * (1 + x)), x); }

/*
 * Reduction by pi/2, Cody and Waite: pi/2 in three parts of 33 bits each
 * (fdlibm's), so n times the first two is exact for |n| < 2^20 and the
 * reduced angle is good to about 1e-25 absolute for |x| below a million.
 * Beyond that it loses accuracy, never determinism.
 */
const INV_PIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_3 = 2.02226624871116645580e-21;

/* 1/(2k+1)! and 1/(2k)!, highest power first, as divisions of exact integers.
 * On |r| <= pi/4 the first dropped terms are under 1e-19 of the result. */
const SIN = [-1 / 121645100408832000, 1 / 355687428096000, -1 / 1307674368000, 1 / 6227020800,
  -1 / 39916800, 1 / 362880, -1 / 5040, 1 / 120, -1 / 6, 1];
const COS = [1 / 2432902008176640000, -1 / 6402373705728000, 1 / 20922789888000, -1 / 87178291200,
  1 / 479001600, -1 / 3628800, 1 / 40320, -1 / 720, 1 / 24, -1 / 2, 1];

function sinKernel(r) {
  const u = r * r;
  let p = SIN[0];
  for (let i = 1; i < SIN.length; i++) p = p * u + SIN[i];
  return r * p;
}

function cosKernel(r) {
  const u = r * r;
  let p = COS[0];
  for (let i = 1; i < COS.length; i++) p = p * u + COS[i];
  return p;
}

/** x as n * pi/2 + r, |r| <= about pi/4, and n's quadrant 0..3. */
function reduce(x) {
  const n = Math.floor(x * INV_PIO2 + 0.5);
  const r = ((x - n * PIO2_1) - n * PIO2_2) - n * PIO2_3;
  return [r, ((n % 4) + 4) % 4];
}

/** sin, radians: within a few ULP for |x| below a million. */
export function sin(x) {
  if (!Number.isFinite(x)) return NaN;
  const [r, q] = reduce(x);
  return q === 0 ? sinKernel(r) : q === 1 ? cosKernel(r) : q === 2 ? -sinKernel(r) : -cosKernel(r);
}

/** cos, radians: within a few ULP for |x| below a million. */
export function cos(x) {
  if (!Number.isFinite(x)) return NaN;
  const [r, q] = reduce(x);
  return q === 0 ? cosKernel(r) : q === 1 ? -sinKernel(r) : q === 2 ? -cosKernel(r) : sinKernel(r);
}

/** tan, radians: within a few ULP for |x| below a million. */
export function tan(x) {
  if (!Number.isFinite(x)) return NaN;
  const [r, q] = reduce(x);
  return q % 2 === 0 ? sinKernel(r) / cosKernel(r) : -cosKernel(r) / sinKernel(r);
}

/*
 * log: x = 2^e * m with m in [sqrt(1/2), sqrt(2)), read exactly from the
 * bits; log m = 2 atanh f, f = (m-1)/(m+1), |f| <= 0.172, as an odd series
 * in f to f^25 (the first dropped term under 1e-18 of the result); and
 * e ln 2 with ln 2 split in two (fdlibm's), the first part exact times e.
 */
const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;
const SQRT_2 = 1.41421356237309504880;
const ATANH = [1 / 25, 1 / 23, 1 / 21, 1 / 19, 1 / 17, 1 / 15, 1 / 13, 1 / 11, 1 / 9, 1 / 7, 1 / 5, 1 / 3, 1];
const bits = new DataView(new ArrayBuffer(8));

/** Natural log: within a few ULP for every positive finite x. */
export function log(x) {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  if (x === Infinity) return Infinity;
  let e = 0;
  if (x < 2.2250738585072014e-308) { x *= 18014398509481984; e = -54; }   // subnormal: times 2^54, exactly
  bits.setFloat64(0, x);
  const hi = bits.getUint32(0);
  e += (hi >>> 20) - 1023;
  bits.setUint32(0, (hi & 0x000fffff) | 0x3ff00000);   // the same mantissa, exponent 0: m in [1, 2)
  let m = bits.getFloat64(0);
  if (m >= SQRT_2) { m /= 2; e += 1; }
  const f = (m - 1) / (m + 1);
  const s = f * f;
  let p = ATANH[0];
  for (let i = 1; i < ATANH.length; i++) p = p * s + ATANH[i];
  return e * LN2_HI + (2 * f * p + e * LN2_LO);
}

/** pi, for the conversions beside these: the same double as Math.PI. */
export { PI };

/** x squared, as a product: `**` is implementation-approximated too. */
export function sq(x) { return x * x; }
