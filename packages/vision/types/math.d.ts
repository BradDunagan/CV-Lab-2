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
export function len2(a: any, b: any): number;
/** Length of (a, b, c). */
export function len3(a: any, b: any, c: any): number;
/**
 * atan2 in radians over (-pi, pi], within a few ULP: `cv_atan2`, the same
 * operations in the same order. Like it, a negative zero `y` gives +0.
 */
export function atan2(y: any, x: any): number;
/** asin, from atan2: within a few ULP over [-1, 1]; NaN outside it. */
export function asin(x: any): number;
/** acos, from atan2: within a few ULP over [-1, 1]; NaN outside it. */
export function acos(x: any): number;
/** sin, radians: within a few ULP for |x| below a million. */
export function sin(x: any): number;
/** cos, radians: within a few ULP for |x| below a million. */
export function cos(x: any): number;
/** tan, radians: within a few ULP for |x| below a million. */
export function tan(x: any): number;
/** Natural log: within a few ULP for every positive finite x. */
export function log(x: any): number;
/** x squared, as a product: `**` is implementation-approximated too. */
export function sq(x: any): number;
export const PI: 3.141592653589793;
