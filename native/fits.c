/*
 * fits.c — see fits.h. Moved here from addon_kernels.c and
 * addon_buffer.c unchanged in what they compute: the same arithmetic in the
 * same order, so the Node-API addon's results kept their hashes.
 */

#include "fits.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "kernels.h"

static CvStatus check_label_map(const CvBuffer *src) {
  if (src->dtype != CV_DTYPE_I32) return CV_ERR_DTYPE;
  if (src->channels != 1) return CV_ERR_CHANNELS;
  return CV_OK;
}

/* ------------------------------------------------------------------ */
/* fitSegments(labels) -- geometry out of a segment label map           */
/*                                                                      */
/* The first operation whose result is not pixels. A label map says      */
/* WHICH edge each pixel belongs to; this says what each edge IS: where  */
/* it starts and ends, which way it runs, and how straight it really is. */
/*                                                                      */
/* Angles are measured from +x, anticlockwise, in IMAGE coordinates --   */
/* where y increases DOWNWARD, so 45 degrees descends to the right on    */
/* screen. Reported in [0, 180), because a line has no direction.        */
/*                                                                      */
/* `residual` is the largest PERPENDICULAR distance from any of the      */
/* segment's pixel centres to its fitted line, in pixels. A maximum      */
/* rather than a mean, so it is a guarantee: no pixel lies further out.  */
/* ------------------------------------------------------------------ */

CvStatus cv_fit_segments(const CvBuffer *src, CvSegmentFit **out, size_t *count_out) {
  *out = NULL;
  *count_out = 0;
  const CvStatus shape = check_label_map(src);
  if (shape != CV_OK) return shape;

  const int64_t cols = src->width, rows = src->height;
  const int32_t *in = (const int32_t *)src->data;
  const size_t n = (size_t)rows * (size_t)cols;

  int32_t count = 0;
  for (size_t i = 0; i < n; i++) if (in[i] > count) count = in[i];
  if (count <= 0) return CV_OK;

  CvTls *fits = (CvTls *)calloc((size_t)count + 1, sizeof(CvTls));
  CvSegmentFit *records = (CvSegmentFit *)calloc((size_t)count, sizeof(CvSegmentFit));
  if (fits == NULL || records == NULL) { free(fits); free(records); return CV_ERR_ALLOC; }
  for (size_t i = 0; i < n; i++) {
    const int32_t id = in[i];
    if (id > 0) cv_tls_add(&fits[id], (double)(i % (size_t)cols), (double)(i / (size_t)cols));
  }

  /*
   * Index the label map once, rather than scanning the whole image per
   * segment. Doing the latter cost 7.7 s on a 1024x1024 checkerboard against
   * 84 ms recorded in the design doc's table -- the same O(segments * pixels)
   * defect `merge` had been fixed for two commits earlier, still sitting here
   * because the table was believed rather than re-measured.
   */
  size_t *offset = NULL;
  int64_t *member_px = NULL;
  {
    const CvStatus indexed = cv_label_index(in, n, count, &offset, &member_px);
    if (indexed != CV_OK) { free(fits); free(records); return indexed; }
  }

  size_t emitted = 0;
  for (int32_t id = 1; id <= count; id++) {
    if (fits[id].n < 2.0) continue;

    double nx, ny, c;
    cv_tls_line(&fits[id], &nx, &ny, &c);
    const double tx = -ny, ty = nx;          /* along the line */

    double lo = 1e300, hi = -1e300, worst = 0.0, sum_sq = 0.0;
    double ax = 0, ay = 0, bx = 0, by = 0;
    for (size_t k = offset[id]; k < offset[id + 1]; k++) {
      const size_t i = (size_t)member_px[k];
      const double x = (double)(i % (size_t)cols), y = (double)(i / (size_t)cols);
      const double t = tx * x + ty * y;
      if (t < lo) { lo = t; ax = x; ay = y; }
      if (t > hi) { hi = t; bx = x; by = y; }
      const double d = cv_tls_distance(nx, ny, c, x, y);
      if (d > worst) worst = d;
      sum_sq += d * d;
    }

    /*
     * Endpoints projected ONTO the fitted line rather than reported as the
     * extreme pixels themselves. That is where the sub-pixel accuracy comes
     * from: the line is an average over every pixel in the segment, so it
     * localises better than any single pixel centre can.
     */
    const double da = cv_tls_distance(nx, ny, c, ax, ay);
    const double db = cv_tls_distance(nx, ny, c, bx, by);
    const double sa = (nx * ax + ny * ay + c) >= 0 ? -da : da;
    const double sb = (nx * bx + ny * by + c) >= 0 ? -db : db;
    const double px0 = ax + nx * sa, py0 = ay + ny * sa;
    const double px1 = bx + nx * sb, py1 = by + ny * sb;

    double angle = cv_atan2(-nx, ny) * (180.0 / CV_PI);
    angle = fmod(angle, 180.0);
    if (angle < 0.0) angle += 180.0;

    CvSegmentFit *r = &records[emitted++];
    r->id = id;
    r->pixels = (int64_t)fits[id].n;
    r->x0 = px0; r->y0 = py0; r->x1 = px1; r->y1 = py1;
    r->length = cv_len2(px1 - px0, py1 - py0);
    r->angle = angle;
    r->residual = worst;
    /* RMS as well as the maximum: the maximum is a guarantee about the worst
     * pixel, the RMS is what error propagation needs when this line gets
     * extrapolated beyond its own extent. */
    r->rms = sqrt(sum_sq / fits[id].n);
    r->cx = fits[id].sx / fits[id].n;
    r->cy = fits[id].sy / fits[id].n;
  }

  free(member_px);
  free(offset);
  free(fits);
  *out = records;
  *count_out = emitted;
  return CV_OK;
}

/* ------------------------------------------------------------------ */
/* fitArcs(labels) -- the same, for labels that are curved             */
/*                                                                      */
/* `fit` describes a label as a line and always can. This describes one  */
/* as a circular arc and often should not, so it reports the evidence    */
/* for the description alongside it -- `rms` against `lineRms`, the      */
/* sweep, and the sagitta -- and leaves the decision to the operation.   */
/* The C emits a candidate per label; src/lab/ops.js applies the gates,  */
/* where they are testable under plain node and visible in a provenance  */
/* record as the parameters they are.                                    */
/*                                                                      */
/* THE MODEL-SELECTION TRAP, which is why the gates exist at all: a      */
/* circle has a parameter a line does not, and on a real edge it spends  */
/* it on noise. Three of the twelve largest STRAIGHT labels on the nut   */
/* fit their own circle 7-21% better than their own line, and nothing    */
/* about one of those fits looks wrong on its own. A residual comparison */
/* alone therefore reclassifies a third of the straight edges in an      */
/* image and reports it as an improvement.                               */
/*                                                                      */
/* Angles are measured from +x through +y in IMAGE coordinates, where y  */
/* increases DOWNWARD -- the same convention `fit` documents -- and the  */
/* arc runs from `angle0` in that direction by `sweep`.                  */
/* ------------------------------------------------------------------ */

/** One member pixel's angle about the fitted centre, for sorting. */
typedef struct { double angle; int64_t index; } CvArcPoint;

/* Total order, so the sort cannot depend on qsort's tie handling: two pixels
 * at the same angle are ordered by their raster index, which is unique. */
static int arc_point_compare(const void *p, const void *q) {
  const CvArcPoint *a = (const CvArcPoint *)p;
  const CvArcPoint *b = (const CvArcPoint *)q;
  if (a->angle < b->angle) return -1;
  if (a->angle > b->angle) return 1;
  return (a->index < b->index) ? -1 : (a->index > b->index);
}

CvStatus cv_fit_arcs(const CvBuffer *src, CvArcFit **out, size_t *count_out) {
  *out = NULL;
  *count_out = 0;
  const CvStatus shape = check_label_map(src);
  if (shape != CV_OK) return shape;

  const int64_t cols = src->width, rows = src->height;
  const int32_t *in = (const int32_t *)src->data;
  const size_t n = (size_t)rows * (size_t)cols;

  int32_t count = 0;
  for (size_t i = 0; i < n; i++) if (in[i] > count) count = in[i];
  if (count <= 0) return CV_OK;

  /* The same fixed origin k_chain uses, so a circle fitted here is the circle
   * that kernel accepted rather than a differently-conditioned one. */
  const double ox = (double)cols * 0.5, oy = (double)rows * 0.5;

  CvCircle *circles = (CvCircle *)calloc((size_t)count + 1, sizeof(CvCircle));
  CvTls *lines = (CvTls *)calloc((size_t)count + 1, sizeof(CvTls));
  CvArcFit *records = (CvArcFit *)calloc((size_t)count, sizeof(CvArcFit));
  if (circles == NULL || lines == NULL || records == NULL) {
    free(circles); free(lines); free(records);
    return CV_ERR_ALLOC;
  }
  for (size_t i = 0; i < n; i++) {
    const int32_t id = in[i];
    if (id <= 0) continue;
    const double x = (double)(i % (size_t)cols), y = (double)(i / (size_t)cols);
    cv_circle_add(&circles[id], x - ox, y - oy);
    cv_tls_add(&lines[id], x, y);
  }

  size_t *offset = NULL;
  int64_t *member_px = NULL;
  {
    const CvStatus indexed = cv_label_index(in, n, count, &offset, &member_px);
    if (indexed != CV_OK) {
      free(circles); free(lines); free(records);
      return indexed;
    }
  }

  size_t scratch = 0;
  for (int32_t id = 1; id <= count; id++) {
    const size_t size = offset[id + 1] - offset[id];
    if (size > scratch) scratch = size;
  }
  CvArcPoint *points = scratch > 0
      ? (CvArcPoint *)malloc(scratch * sizeof(CvArcPoint)) : NULL;
  if (scratch > 0 && points == NULL) {
    free(member_px); free(offset); free(circles); free(lines); free(records);
    return CV_ERR_ALLOC;
  }

  size_t emitted = 0;
  for (int32_t id = 1; id <= count; id++) {
    if (circles[id].n < 3.0) continue;

    double cx, cy, radius;
    if (!cv_circle_solve(&circles[id], &cx, &cy, &radius)) continue;
    cx += ox; cy += oy;

    /* Radial residuals, and the line's for comparison. */
    double nx, ny, lc;
    cv_tls_line(&lines[id], &nx, &ny, &lc);

    double worst = 0.0, sum_sq = 0.0, line_sq = 0.0;
    size_t written = 0;
    for (size_t k = offset[id]; k < offset[id + 1]; k++) {
      const size_t i = (size_t)member_px[k];
      const double x = (double)(i % (size_t)cols), y = (double)(i / (size_t)cols);
      const double d = cv_circle_distance(cx, cy, radius, x, y);
      if (d > worst) worst = d;
      sum_sq += d * d;
      const double dl = cv_tls_distance(nx, ny, lc, x, y);
      line_sq += dl * dl;
      points[written].angle = cv_atan2(y - cy, x - cx);
      points[written].index = (int64_t)i;
      written++;
    }
    if (written == 0) continue;

    /*
     * The arc's extent, by the LARGEST-GAP construction.
     *
     * Min and max of the angle is wrong for any arc straddling the branch cut
     * at +/-pi: it returns the two ends of the empty side. So the arc is
     * everything except the largest angular gap, which also gives the sweep
     * for free and degrades honestly on a closed circle -- there the largest
     * gap is the mean spacing and the sweep comes back near 360.
     */
    qsort(points, written, sizeof(CvArcPoint), arc_point_compare);
    double gap = points[0].angle + 2.0 * CV_PI - points[written - 1].angle;
    size_t before = written - 1;
    for (size_t k = 1; k < written; k++) {
      const double g = points[k].angle - points[k - 1].angle;
      if (g > gap) { gap = g; before = k - 1; }
    }
    const size_t start = (before + 1) % written;
    const double a0 = points[start].angle;
    const double a1 = points[before].angle;
    const size_t ends[2] = { (size_t)points[start].index, (size_t)points[before].index };
    double sweep = a1 - a0;
    while (sweep < 0.0) sweep += 2.0 * CV_PI;

    /*
     * Endpoints projected ONTO the fitted circle, radially, rather than
     * reported as the extreme pixels themselves -- the same reasoning as
     * `fit`, one dimension round. The circle is an average over every pixel in
     * the label, so it localises the end better than that pixel's centre can.
     *
     * By projecting the extreme PIXEL along its own radius rather than
     * evaluating the circle at a0, this needs no sine or cosine. That is not
     * tidiness: libm's trigonometry is not required to be correctly rounded,
     * and cv_tls_line's comment records what three platforms did to `fit` when
     * geometry went through it. The result is the same point -- the projection
     * lies on the ray the angle names -- reached with multiplication, addition
     * and one square root.
     */
    const double e0x = (double)(ends[0] % (size_t)cols), e0y = (double)(ends[0] / (size_t)cols);
    const double e1x = (double)(ends[1] % (size_t)cols), e1y = (double)(ends[1] / (size_t)cols);
    double px0 = e0x, py0 = e0y, px1 = e1x, py1 = e1y;
    {
      const double d0 = cv_len2(e0x - cx, e0y - cy);
      if (d0 > 0.0) { px0 = cx + (e0x - cx) * radius / d0; py0 = cy + (e0y - cy) * radius / d0; }
      const double d1 = cv_len2(e1x - cx, e1y - cy);
      if (d1 > 0.0) { px1 = cx + (e1x - cx) * radius / d1; py1 = cy + (e1y - cy) * radius / d1; }
    }
    const double chord = cv_len2(px1 - px0, py1 - py0);

    CvArcFit *r = &records[emitted++];
    r->id = id;
    r->pixels = (int64_t)written;
    r->cx = cx; r->cy = cy; r->r = radius;
    r->x0 = px0; r->y0 = py0; r->x1 = px1; r->y1 = py1;
    /* cv_atan2 returns (-pi, pi]; arcs are reported over [0, 360) because an
     * arc, unlike a line, does have a direction and a start. */
    double d0 = a0 * (180.0 / CV_PI), d1 = a1 * (180.0 / CV_PI);
    if (d0 < 0.0) d0 += 360.0;
    if (d1 < 0.0) d1 += 360.0;
    r->angle0 = d0;
    r->angle1 = d1;
    r->sweep = sweep * (180.0 / CV_PI);
    r->arc_length = radius * sweep;
    r->chord = chord;
    /* How far the arc bows off its own chord: the scale-free statement of
     * "this is curved", and what the operation gates on. */
    r->sagitta = cv_circle_sagitta(radius, chord, sweep > CV_PI);
    r->residual = worst;
    r->rms = sqrt(sum_sq / (double)written);
    /* The line this label would have been described as, so the operation can
     * ask whether the arc earned the extra parameter rather than assuming it. */
    r->line_rms = sqrt(line_sq / (double)written);
    r->mx = circles[id].sx / circles[id].n + ox;
    r->my = circles[id].sy / circles[id].n + oy;
  }

  free(points);
  free(member_px);
  free(offset);
  free(circles);
  free(lines);
  *out = records;
  *count_out = emitted;
  return CV_OK;
}

/* ------------------------------------------------------------------ */
/* bufferFromRGBA8 -- the bridge from an image decoder into a lab buffer */
/*                                                                      */
/* The decoder hands back 8-bit RGBA; this converts to the f32 working  */
/* format and drops alpha. Because the source is 8-bit, sRGB -> linear  */
/* is an EXACT 256-entry lookup rather than a per-pixel power function  */
/* -- no approximation, and no transcendental in the inner loop.        */
/* ------------------------------------------------------------------ */

/*
 * Note the deliberate round through float: the value is narrowed to f32
 * BEFORE the transfer function is applied.
 *
 * Without it, `load(as=linear)` and `toLinear(load(...))` disagree by one f32
 * ULP on about half the byte values -- mathematically the same result reached
 * by two routes, differing because one of them stores an intermediate as f32
 * and the other does not. Numerically that is nothing; for a lab that compares
 * content hashes it is the difference between two provenance chains agreeing
 * and not. Where two routes to the same value exist, make them agree on
 * purpose.
 */
static float srgb_to_linear_byte(int i) {
  const double s = (double)(float)((double)i / 255.0);
  return (float)(s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4));
}

static float linear_to_srgb_byte(int i) {
  const double l = (double)(float)((double)i / 255.0);
  return (float)(l <= 0.0031308 ? 12.92 * l : 1.055 * pow(l, 1.0 / 2.4) - 0.055);
}

CvStatus cv_buffer_from_rgba8(CvBuffer *out, const uint8_t *rgba, size_t length,
                              int64_t width, int64_t height, bool from_linear,
                              bool as_linear) {
  /* Hostile input (§3): check the geometry against the actual byte count
   * before trusting either. */
  size_t expected = 0;
  if (!cv_mul_checked((size_t)(width > 0 ? width : 0), (size_t)(height > 0 ? height : 0), &expected) ||
      !cv_mul_checked(expected, 4, &expected)) {
    return CV_ERR_OVERFLOW;
  }
  if (expected == 0 || length != expected) return CV_ERR_SHAPE;

  /*
   * 8-bit input means the whole transfer function is exactly 256 values, so
   * every combination is a lookup rather than a per-pixel power function.
   *
   * `from` says what the stored bytes MEAN; `as` says what the buffer should
   * hold. When they agree there is no curve to apply at all -- linear samples
   * stored as bytes are already linear once divided by 255.
   */
  float lut[256];
  for (int i = 0; i < 256; i++) {
    if (from_linear == as_linear) {
      lut[i] = (float)((double)i / 255.0);
    } else if (as_linear) {
      lut[i] = srgb_to_linear_byte(i);      /* srgb bytes -> linear values */
    } else {
      lut[i] = linear_to_srgb_byte(i);      /* linear bytes -> srgb values */
    }
  }

  const CvStatus status = cv_buffer_alloc(out, width, height, 3, CV_DTYPE_F32,
                                          as_linear ? CV_SPACE_LINEAR : CV_SPACE_SRGB);
  if (status != CV_OK) return status;

  float *dst = (float *)out->data;
  const size_t pixels = (size_t)width * (size_t)height;
  for (size_t i = 0; i < pixels; i++) {
    dst[i * 3 + 0] = lut[rgba[i * 4 + 0]];
    dst[i * 3 + 1] = lut[rgba[i * 4 + 1]];
    dst[i * 3 + 2] = lut[rgba[i * 4 + 2]];
    /* alpha is dropped: the lab has no compositing model yet */
  }
  return CV_OK;
}
