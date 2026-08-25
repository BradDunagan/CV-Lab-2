#include "kernels.h"

#include <math.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/* parameter access                                                     */
/* ------------------------------------------------------------------ */

static const CvParam *find_param(const CvParams *params, const char *name) {
  if (params == NULL) return NULL;
  for (size_t i = 0; i < params->count; i++) {
    if (strcmp(params->items[i].name, name) == 0) return &params->items[i];
  }
  return NULL;
}

double cv_param_num(const CvParams *params, const char *name, double fallback) {
  const CvParam *p = find_param(params, name);
  return (p && p->kind == CV_PARAM_NUMBER) ? p->number : fallback;
}

bool cv_param_bool(const CvParams *params, const char *name, bool fallback) {
  const CvParam *p = find_param(params, name);
  return (p && p->kind == CV_PARAM_BOOL) ? p->boolean : fallback;
}

const char *cv_param_str(const CvParams *params, const char *name, const char *fallback) {
  const CvParam *p = find_param(params, name);
  return (p && p->kind == CV_PARAM_STRING) ? p->string : fallback;
}

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

static bool is_cancelled(const CvKernelCtx *ctx) {
  return ctx != NULL && ctx->cancel != NULL && *ctx->cancel != 0;
}

/* Mirror out-of-range coordinates back inside. Avoids the edge darkening a
 * zero border produces when a normalised kernel runs off the image. */
static CV_INLINE int64_t reflect(int64_t v, int64_t n) {
  if (n == 1) return 0;
  while (v < 0 || v >= n) {
    if (v < 0) v = -v - 1;
    if (v >= n) v = 2 * n - v - 1;
  }
  return v;
}

static float *f32(const CvBuffer *b) { return (float *)b->data; }

/* ------------------------------------------------------------------ */
/* pattern(kind, width, height, channels) -> buffer                     */
/*                                                                      */
/* A source that needs no file. Real image loading depends on an open    */
/* question in §11 (where decoding happens); synthetic patterns are      */
/* independently useful for checking a kernel does what it claims.       */
/* ------------------------------------------------------------------ */

static CvStatus k_pattern(const CvBuffer *const *inputs, size_t n_inputs,
                          const CvParams *params, CvBuffer *out,
                          CvScalars *scalars, const CvKernelCtx *ctx) {
  (void)inputs; (void)n_inputs; (void)scalars;

  const int64_t width = (int64_t)cv_param_num(params, "width", 64);
  const int64_t height = (int64_t)cv_param_num(params, "height", 64);
  const int32_t channels = (int32_t)cv_param_num(params, "channels", 1);
  const char *kind = cv_param_str(params, "kind", "ramp");

  CvStatus status = cv_buffer_alloc(out, width, height, channels,
                                    CV_DTYPE_F32, CV_SPACE_LINEAR);
  if (status != CV_OK) return status;

  float *dst = f32(out);
  const double denom = (width > 1) ? (double)(width - 1) : 1.0;

  for (int64_t y = 0; y < height; y++) {
    if ((y & 63) == 0 && is_cancelled(ctx)) { cv_buffer_free(out); return CV_ERR_CANCELLED; }
    for (int64_t x = 0; x < width; x++) {
      double value;
      if (strcmp(kind, "checker") == 0) {
        value = (((x / 8) + (y / 8)) & 1) ? 1.0 : 0.0;
      } else if (strcmp(kind, "impulse") == 0) {
        value = (x == width / 2 && y == height / 2) ? 1.0 : 0.0;
      } else if (strcmp(kind, "constant") == 0) {
        value = cv_param_num(params, "value", 0.5);
      } else { /* ramp */
        value = (double)x / denom;
      }
      for (int32_t c = 0; c < channels; c++) {
        /* Give colour patterns per-channel variation so gray() is testable. */
        double v = value;
        if (channels == 3 && strcmp(kind, "ramp") == 0) {
          v = (c == 0) ? value : (c == 1) ? 1.0 - value : 0.5;
        }
        dst[(y * width + x) * channels + c] = (float)v;
      }
    }
  }
  return CV_OK;
}

/* ------------------------------------------------------------------ */
/* gray(src) -> 1 channel                                               */
/*                                                                      */
/* Rec.709 luminance. These coefficients are valid on LINEAR values      */
/* only (§2); applied to sRGB-encoded values they compute luma, which    */
/* is a different quantity. The registry declares space: 'linear' so     */
/* the runtime converts or refuses rather than quietly doing the wrong   */
/* thing here.                                                           */
/* ------------------------------------------------------------------ */

static CvStatus k_gray(const CvBuffer *const *inputs, size_t n_inputs,
                       const CvParams *params, CvBuffer *out,
                       CvScalars *scalars, const CvKernelCtx *ctx) {
  (void)n_inputs; (void)params; (void)scalars;
  const CvBuffer *src = inputs[0];
  if (src->channels != 3) return CV_ERR_CHANNELS;

  CvStatus status = cv_buffer_alloc(out, src->width, src->height, 1,
                                    CV_DTYPE_F32, src->space);
  if (status != CV_OK) return status;

  const float *in = f32(src);
  float *dst = f32(out);
  const int64_t rows = src->height, cols = src->width;

  for (int64_t y = 0; y < rows; y++) {
    if ((y & 63) == 0 && is_cancelled(ctx)) { cv_buffer_free(out); return CV_ERR_CANCELLED; }
    for (int64_t x = 0; x < cols; x++) {
      const size_t i = (size_t)(y * cols + x) * 3;
      dst[y * cols + x] =
          (float)(0.2126 * in[i] + 0.7152 * in[i + 1] + 0.0722 * in[i + 2]);
    }
  }
  return CV_OK;
}

/* ------------------------------------------------------------------ */
/* gaussian(src, sigma) -> same shape                                   */
/*                                                                      */
/* Separable: two 1-D passes rather than one 2-D pass, O(2r) per pixel   */
/* instead of O(r^2). Blur mixes pixels, so it models light and wants    */
/* linear values -- declared in the registry, enforced above this layer. */
/* ------------------------------------------------------------------ */

static CvStatus k_gaussian(const CvBuffer *const *inputs, size_t n_inputs,
                           const CvParams *params, CvBuffer *out,
                           CvScalars *scalars, const CvKernelCtx *ctx) {
  (void)n_inputs; (void)scalars;
  const CvBuffer *src = inputs[0];
  const double sigma = cv_param_num(params, "sigma", 1.4);
  if (!(sigma > 0.0)) return CV_ERR_DIMS;

  const int64_t radius = (int64_t)ceil(3.0 * sigma);
  const size_t taps = (size_t)(2 * radius + 1);

  float *weights = (float *)cv_aligned_alloc(CV_ALIGN, ((taps * sizeof(float)) + CV_ALIGN) & ~(size_t)(CV_ALIGN - 1));
  if (weights == NULL) return CV_ERR_ALLOC;

  double sum = 0.0;
  for (int64_t i = -radius; i <= radius; i++) {
    const double w = exp(-(double)(i * i) / (2.0 * sigma * sigma));
    weights[i + radius] = (float)w;
    sum += w;
  }
  for (size_t i = 0; i < taps; i++) weights[i] = (float)(weights[i] / sum);

  CvStatus status = cv_buffer_alloc(out, src->width, src->height, src->channels,
                                    CV_DTYPE_F32, src->space);
  if (status != CV_OK) { cv_aligned_free(weights); return status; }

  CvBuffer tmp;
  status = cv_buffer_alloc(&tmp, src->width, src->height, src->channels,
                           CV_DTYPE_F32, src->space);
  if (status != CV_OK) { cv_aligned_free(weights); cv_buffer_free(out); return status; }

  const int64_t rows = src->height, cols = src->width;
  const int32_t ch = src->channels;
  const float *in = f32(src);
  float *mid = f32(&tmp);
  float *dst = f32(out);

  /* horizontal */
  for (int64_t y = 0; y < rows; y++) {
    if ((y & 31) == 0 && is_cancelled(ctx)) goto cancelled;
    for (int64_t x = 0; x < cols; x++) {
      for (int32_t c = 0; c < ch; c++) {
        double acc = 0.0;
        for (int64_t k = -radius; k <= radius; k++) {
          const int64_t sx = reflect(x + k, cols);
          acc += (double)weights[k + radius] * in[(size_t)(y * cols + sx) * ch + c];
        }
        mid[(size_t)(y * cols + x) * ch + c] = (float)acc;
      }
    }
  }

  /* vertical */
  for (int64_t y = 0; y < rows; y++) {
    if ((y & 31) == 0 && is_cancelled(ctx)) goto cancelled;
    for (int64_t x = 0; x < cols; x++) {
      for (int32_t c = 0; c < ch; c++) {
        double acc = 0.0;
        for (int64_t k = -radius; k <= radius; k++) {
          const int64_t sy = reflect(y + k, rows);
          acc += (double)weights[k + radius] * mid[(size_t)(sy * cols + x) * ch + c];
        }
        dst[(size_t)(y * cols + x) * ch + c] = (float)acc;
      }
    }
  }

  cv_buffer_free(&tmp);
  cv_aligned_free(weights);
  return CV_OK;

cancelled:
  cv_buffer_free(&tmp);
  cv_buffer_free(out);
  cv_aligned_free(weights);
  return CV_ERR_CANCELLED;
}

/* ------------------------------------------------------------------ */
/* sobel(src, axis) -> 1 channel, SIGNED for x and y                    */
/*                                                                      */
/* Divided by 8, the sum of absolute weights, so a clean 0->1 edge gives */
/* a response near 1.0 rather than 8.0. Output space is 'none': a        */
/* derivative is not a colour.                                           */
/* ------------------------------------------------------------------ */

static CvStatus k_sobel(const CvBuffer *const *inputs, size_t n_inputs,
                        const CvParams *params, CvBuffer *out,
                        CvScalars *scalars, const CvKernelCtx *ctx) {
  (void)n_inputs; (void)scalars;
  const CvBuffer *src = inputs[0];
  if (src->channels != 1) return CV_ERR_CHANNELS;

  const char *axis = cv_param_str(params, "axis", "mag");
  const bool want_x = (strcmp(axis, "x") == 0) || (strcmp(axis, "mag") == 0);
  const bool want_y = (strcmp(axis, "y") == 0) || (strcmp(axis, "mag") == 0);
  const bool magnitude = (strcmp(axis, "mag") == 0);

  CvStatus status = cv_buffer_alloc(out, src->width, src->height, 1,
                                    CV_DTYPE_F32, CV_SPACE_NONE);
  if (status != CV_OK) return status;

  const int64_t rows = src->height, cols = src->width;
  const float *in = f32(src);
  float *dst = f32(out);

  static const double KX[3][3] = {{-1, 0, 1}, {-2, 0, 2}, {-1, 0, 1}};
  static const double KY[3][3] = {{-1, -2, -1}, {0, 0, 0}, {1, 2, 1}};

  for (int64_t y = 0; y < rows; y++) {
    if ((y & 63) == 0 && is_cancelled(ctx)) { cv_buffer_free(out); return CV_ERR_CANCELLED; }
    for (int64_t x = 0; x < cols; x++) {
      double gx = 0.0, gy = 0.0;
      for (int64_t j = -1; j <= 1; j++) {
        const int64_t sy = reflect(y + j, rows);
        for (int64_t i = -1; i <= 1; i++) {
          const int64_t sx = reflect(x + i, cols);
          const double v = in[sy * cols + sx];
          if (want_x) gx += KX[j + 1][i + 1] * v;
          if (want_y) gy += KY[j + 1][i + 1] * v;
        }
      }
      const double value = magnitude ? sqrt(gx * gx + gy * gy) / 8.0
                                     : (want_x ? gx : gy) / 8.0;
      dst[y * cols + x] = (float)value;
    }
  }
  return CV_OK;
}

/* ------------------------------------------------------------------ */
/* threshold(src, t, invert) -> i32 mask                                */
/*                                                                      */
/* A mask is an identity, not a measurement: i32, space none. Ordering   */
/* is invariant under a monotonic transfer function, so colour space     */
/* genuinely does not matter here (§2).                                  */
/* ------------------------------------------------------------------ */

static CvStatus k_threshold(const CvBuffer *const *inputs, size_t n_inputs,
                            const CvParams *params, CvBuffer *out,
                            CvScalars *scalars, const CvKernelCtx *ctx) {
  (void)n_inputs; (void)scalars;
  const CvBuffer *src = inputs[0];
  if (src->channels != 1) return CV_ERR_CHANNELS;

  const double t = cv_param_num(params, "t", 0.5);
  const bool invert = cv_param_bool(params, "invert", false);

  CvStatus status = cv_buffer_alloc(out, src->width, src->height, 1,
                                    CV_DTYPE_I32, CV_SPACE_NONE);
  if (status != CV_OK) return status;

  const float *in = f32(src);
  int32_t *dst = (int32_t *)out->data;
  const size_t n = cv_buffer_elements(src);

  for (size_t i = 0; i < n; i++) {
    if ((i & 0xFFFF) == 0 && is_cancelled(ctx)) { cv_buffer_free(out); return CV_ERR_CANCELLED; }
    const bool above = (double)in[i] > t;
    dst[i] = (above != invert) ? 1 : 0;
  }
  return CV_OK;
}

/* ------------------------------------------------------------------ */
/* stats(src) -> scalars                                                */
/*                                                                      */
/* §5, determinism rule 1: floating-point addition is not associative,   */
/* so a reduction whose summation order varies gives different last      */
/* bits run to run. Accumulate per fixed-size tile, then combine tiles    */
/* in ascending index order. Single-threaded today; parallelising this    */
/* later cannot change the answer, because the order is a property of     */
/* the tiling and not of which thread finished first.                     */
/* ------------------------------------------------------------------ */

#define CV_TILE 4096

static CvStatus k_stats(const CvBuffer *const *inputs, size_t n_inputs,
                        const CvParams *params, CvBuffer *out,
                        CvScalars *scalars, const CvKernelCtx *ctx) {
  (void)n_inputs; (void)params; (void)out;
  const CvBuffer *src = inputs[0];
  const size_t n = cv_buffer_elements(src);
  if (n == 0) return CV_ERR_DIMS;

  const bool is_int = (src->dtype == CV_DTYPE_I32);
  const float *fin = is_int ? NULL : f32(src);
  const int32_t *iin = is_int ? (const int32_t *)src->data : NULL;

  double lo = INFINITY, hi = -INFINITY, total = 0.0, total_sq = 0.0;

  for (size_t base = 0; base < n; base += CV_TILE) {
    if (is_cancelled(ctx)) return CV_ERR_CANCELLED;
    const size_t end = (base + CV_TILE < n) ? base + CV_TILE : n;
    double tile_sum = 0.0, tile_sq = 0.0;
    for (size_t i = base; i < end; i++) {
      const double v = is_int ? (double)iin[i] : (double)fin[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      tile_sum += v;
      tile_sq += v * v;
    }
    total += tile_sum;      /* fixed order: tile 0, then 1, then 2 ... */
    total_sq += tile_sq;
  }

  const double mean = total / (double)n;
  const double variance = (total_sq / (double)n) - (mean * mean);
  scalars->min = lo;
  scalars->max = hi;
  scalars->mean = mean;
  scalars->stddev = sqrt(variance > 0.0 ? variance : 0.0);
  scalars->count = (int64_t)n;
  return CV_OK;
}

/* ------------------------------------------------------------------ */
/* toLinear(src) / toSrgb(src)                                          */
/*                                                                      */
/* The colour-space conversion, as an explicit operation rather than    */
/* something the runtime inserts silently. A conversion that appears in */
/* the log is a conversion the provenance can explain.                  */
/* ------------------------------------------------------------------ */

static double srgb_to_linear(double s) {
  return (s <= 0.04045) ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4);
}

static double linear_to_srgb(double l) {
  return (l <= 0.0031308) ? 12.92 * l : 1.055 * pow(l, 1.0 / 2.4) - 0.055;
}

static CvStatus convert_space(const CvBuffer *src, CvBuffer *out,
                              CvSpace to, const CvKernelCtx *ctx) {
  if (src->dtype != CV_DTYPE_F32) return CV_ERR_DTYPE;

  CvStatus status = cv_buffer_alloc(out, src->width, src->height, src->channels,
                                    CV_DTYPE_F32, to);
  if (status != CV_OK) return status;

  const float *in = f32(src);
  float *dst = f32(out);
  const size_t n = cv_buffer_elements(src);

  for (size_t i = 0; i < n; i++) {
    if ((i & 0xFFFF) == 0 && is_cancelled(ctx)) { cv_buffer_free(out); return CV_ERR_CANCELLED; }
    const double v = (double)in[i];
    /* Values outside 0..1 are passed through: the transfer function is only
     * defined on the unit interval, and clamping would destroy data. */
    if (v < 0.0 || v > 1.0) { dst[i] = in[i]; continue; }
    dst[i] = (float)((to == CV_SPACE_LINEAR) ? srgb_to_linear(v) : linear_to_srgb(v));
  }
  return CV_OK;
}

static CvStatus k_to_linear(const CvBuffer *const *inputs, size_t n_inputs,
                            const CvParams *params, CvBuffer *out,
                            CvScalars *scalars, const CvKernelCtx *ctx) {
  (void)n_inputs; (void)params; (void)scalars;
  return convert_space(inputs[0], out, CV_SPACE_LINEAR, ctx);
}

static CvStatus k_to_srgb(const CvBuffer *const *inputs, size_t n_inputs,
                          const CvParams *params, CvBuffer *out,
                          CvScalars *scalars, const CvKernelCtx *ctx) {
  (void)n_inputs; (void)params; (void)scalars;
  return convert_space(inputs[0], out, CV_SPACE_SRGB, ctx);
}

static CvStatus k_nms(const CvBuffer *const *inputs, size_t n_inputs,
                      const CvParams *params, CvBuffer *out,
                      CvScalars *scalars, const CvKernelCtx *ctx);
static CvStatus k_hysteresis(const CvBuffer *const *inputs, size_t n_inputs,
                             const CvParams *params, CvBuffer *out,
                             CvScalars *scalars, const CvKernelCtx *ctx);
static CvStatus k_orient(const CvBuffer *const *inputs, size_t n_inputs,
                         const CvParams *params, CvBuffer *out,
                         CvScalars *scalars, const CvKernelCtx *ctx);
static CvStatus k_segments(const CvBuffer *const *inputs, size_t n_inputs,
                           const CvParams *params, CvBuffer *out,
                           CvScalars *scalars, const CvKernelCtx *ctx);

/* ------------------------------------------------------------------ */
/* the table                                                            */
/* ------------------------------------------------------------------ */

static const CvKernelEntry KERNELS[] = {
  { "pattern",   k_pattern,   0, true  },
  { "gray",      k_gray,      1, true  },
  { "gaussian",  k_gaussian,  1, true  },
  { "sobel",     k_sobel,     1, true  },
  { "threshold", k_threshold, 1, true  },
  { "stats",     k_stats,     1, false },
  { "toLinear",  k_to_linear, 1, true  },
  { "toSrgb",    k_to_srgb,   1, true  },
  { "nms",        k_nms,        3, true },
  { "hysteresis", k_hysteresis, 1, true },
  { "orient",     k_orient,     2, true },
  { "segments",   k_segments,   3, true },
};

const CvKernelEntry *cv_kernel_lookup(const char *name) {
  if (name == NULL) return NULL;
  for (size_t i = 0; i < sizeof(KERNELS) / sizeof(KERNELS[0]); i++) {
    if (strcmp(KERNELS[i].name, name) == 0) return &KERNELS[i];
  }
  return NULL;
}

size_t cv_kernel_count(void) { return sizeof(KERNELS) / sizeof(KERNELS[0]); }

const CvKernelEntry *cv_kernel_at(size_t index) {
  return (index < cv_kernel_count()) ? &KERNELS[index] : NULL;
}

/* ------------------------------------------------------------------ */
/* nms(mag, gx, gy) -- non-maximum suppression                          */
/*                                                                      */
/* Canny stage 3. A gradient magnitude image has ridges several pixels  */
/* wide; an edge is one pixel. Keep a pixel only where it is a maximum  */
/* ALONG the gradient direction -- across the ridge, not along it.      */
/*                                                                      */
/* The direction is quantised to four, using ratio comparisons rather   */
/* than atan2: tan(22.5 deg) and tan(67.5 deg) are the two boundaries.  */
/* ------------------------------------------------------------------ */

#define CV_TAN_22_5 0.41421356237309503
#define CV_TAN_67_5 2.41421356237309515

static CvStatus k_nms(const CvBuffer *const *inputs, size_t n_inputs,
                      const CvParams *params, CvBuffer *out,
                      CvScalars *scalars, const CvKernelCtx *ctx) {
  (void)n_inputs; (void)params; (void)scalars;
  const CvBuffer *mag = inputs[0];
  const CvBuffer *gx = inputs[1];
  const CvBuffer *gy = inputs[2];

  if (mag->channels != 1 || gx->channels != 1 || gy->channels != 1) return CV_ERR_CHANNELS;
  if (mag->dtype != CV_DTYPE_F32 || gx->dtype != CV_DTYPE_F32 || gy->dtype != CV_DTYPE_F32) {
    return CV_ERR_DTYPE;
  }
  if (gx->width != mag->width || gx->height != mag->height ||
      gy->width != mag->width || gy->height != mag->height) {
    return CV_ERR_SHAPE;
  }

  CvStatus status = cv_buffer_alloc(out, mag->width, mag->height, 1,
                                    CV_DTYPE_F32, CV_SPACE_NONE);
  if (status != CV_OK) return status;

  const int64_t rows = mag->height, cols = mag->width;
  const float *m = f32(mag), *dx = f32(gx), *dy = f32(gy);
  float *dst = f32(out);

  for (int64_t y = 0; y < rows; y++) {
    if ((y & 63) == 0 && is_cancelled(ctx)) { cv_buffer_free(out); return CV_ERR_CANCELLED; }
    for (int64_t x = 0; x < cols; x++) {
      const size_t i = (size_t)(y * cols + x);
      const double value = m[i];
      if (value <= 0.0) { dst[i] = 0.0f; continue; }

      const double ax = fabs((double)dx[i]);
      const double ay = fabs((double)dy[i]);

      int64_t sx, sy;
      if (ay <= ax * CV_TAN_22_5) {          /* gradient mostly horizontal */
        sx = 1; sy = 0;
      } else if (ay >= ax * CV_TAN_67_5) {   /* mostly vertical */
        sx = 0; sy = 1;
      } else if ((double)dx[i] * (double)dy[i] > 0.0) {
        sx = 1; sy = 1;
      } else {
        sx = 1; sy = -1;
      }

      const double before = m[reflect(y - sy, rows) * cols + reflect(x - sx, cols)];
      const double after  = m[reflect(y + sy, rows) * cols + reflect(x + sx, cols)];

      /*
       * Asymmetric on purpose: `>` one way and `>=` the other. With `>=` both
       * ways a ridge exactly two pixels wide keeps both, and the whole point
       * of this stage is to leave one.
       */
      dst[i] = (value > before && value >= after) ? (float)value : 0.0f;
    }
  }
  return CV_OK;
}

/* ------------------------------------------------------------------ */
/* hysteresis(src, low, high) -> i32 mask                               */
/*                                                                      */
/* Canny stage 4. Two thresholds: anything above `high` is an edge;     */
/* anything above `low` is an edge only if it connects, through other   */
/* above-low pixels, to something above `high`. That is what keeps a    */
/* faint continuation of a strong edge while dropping isolated noise.   */
/*                                                                      */
/* Order-independent by construction -- a pixel either reaches a strong  */
/* seed or it does not -- so unlike a reduction this needs no care about */
/* traversal order to stay deterministic (§5).                          */
/* ------------------------------------------------------------------ */

static CvStatus k_hysteresis(const CvBuffer *const *inputs, size_t n_inputs,
                             const CvParams *params, CvBuffer *out,
                             CvScalars *scalars, const CvKernelCtx *ctx) {
  (void)n_inputs; (void)scalars;
  const CvBuffer *src = inputs[0];
  if (src->channels != 1) return CV_ERR_CHANNELS;
  if (src->dtype != CV_DTYPE_F32) return CV_ERR_DTYPE;

  const double low = cv_param_num(params, "low", 0.05);
  const double high = cv_param_num(params, "high", 0.15);
  if (low > high) return CV_ERR_PARAM;

  CvStatus status = cv_buffer_alloc(out, src->width, src->height, 1,
                                    CV_DTYPE_I32, CV_SPACE_NONE);
  if (status != CV_OK) return status;

  const int64_t rows = src->height, cols = src->width;
  const float *m = f32(src);
  int32_t *dst = (int32_t *)out->data;
  const size_t n = (size_t)rows * (size_t)cols;

  /*
   * A stack of pixels waiting to be walked from. Each pixel is pushed at most
   * once, because it is marked before being pushed -- so the worst case is n,
   * but a typical edge map needs a small fraction of that. Start small and
   * double, rather than allocating 96 MB for a 12 MP image that will use a
   * few hundred kilobytes.
   */
  size_t capacity = 1024;
  int64_t *stack = (int64_t *)malloc(capacity * sizeof(int64_t));
  if (stack == NULL) { cv_buffer_free(out); return CV_ERR_ALLOC; }
  size_t top = 0;

  for (size_t i = 0; i < n; i++) {
    if ((double)m[i] >= high) {
      dst[i] = 1;
      if (top == capacity) {
        const size_t grown = capacity * 2;
        int64_t *bigger = (int64_t *)realloc(stack, grown * sizeof(int64_t));
        if (bigger == NULL) { free(stack); cv_buffer_free(out); return CV_ERR_ALLOC; }
        stack = bigger;
        capacity = grown;
      }
      stack[top++] = (int64_t)i;
    }
  }

  /*
   * The first kernel whose work is data-dependent rather than a fixed pixel
   * loop, and therefore the first where polling the cancellation flag mid-run
   * actually matters.
   */
  size_t since_check = 0;
  while (top > 0) {
    if (++since_check >= 4096) {
      since_check = 0;
      if (is_cancelled(ctx)) { free(stack); cv_buffer_free(out); return CV_ERR_CANCELLED; }
    }

    const int64_t index = stack[--top];
    const int64_t y = index / cols;
    const int64_t x = index % cols;

    for (int64_t dy = -1; dy <= 1; dy++) {
      for (int64_t dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        const int64_t ny = y + dy, nx = x + dx;
        if (ny < 0 || nx < 0 || ny >= rows || nx >= cols) continue;   /* no reflection here:
                                                                         connectivity must not
                                                                         wrap around an edge */
        const size_t ni = (size_t)(ny * cols + nx);
        if (dst[ni] != 0) continue;
        if ((double)m[ni] < low) continue;
        dst[ni] = 1;
        if (top == capacity) {
          const size_t grown = capacity * 2;
          int64_t *bigger = (int64_t *)realloc(stack, grown * sizeof(int64_t));
          if (bigger == NULL) { free(stack); cv_buffer_free(out); return CV_ERR_ALLOC; }
          stack = bigger;
          capacity = grown;
        }
        stack[top++] = (int64_t)ni;
      }
    }
  }

  free(stack);
  return CV_OK;
}

/* ------------------------------------------------------------------ */
/* orient(gx, gy) -- gradient direction, in radians                     */
/*                                                                      */
/* The angle of the gradient vector: which way brightness increases.    */
/* Perpendicular to the edge itself, always.                            */
/*                                                                      */
/* `range=signed` keeps the full turn, (-pi, pi]. That distinguishes a  */
/* dark-to-bright edge from a bright-to-dark one, which sit 180 degrees */
/* apart -- so a thin bright line on a dark background yields two       */
/* orientations, one per side. That is truthful: there really are two   */
/* edges there.                                                         */
/*                                                                      */
/* `range=unsigned` folds onto [0, pi), merging the two sides. Cheap to */
/* derive from signed; impossible to recover once discarded, which is   */
/* why signed is the default.                                           */
/*                                                                      */
/* Where the gradient is ~0 the angle is meaningless -- a flat region    */
/* has no direction. Zero is emitted deliberately rather than relying   */
/* on atan2(0,0) incidentally returning it. Masking by magnitude is the */
/* caller's job, not this kernel's (§3: do not fuse stages).            */
/* ------------------------------------------------------------------ */

#define CV_ORIENT_EPS 1e-12

static CvStatus k_orient(const CvBuffer *const *inputs, size_t n_inputs,
                         const CvParams *params, CvBuffer *out,
                         CvScalars *scalars, const CvKernelCtx *ctx) {
  (void)n_inputs; (void)scalars;
  const CvBuffer *gx = inputs[0];
  const CvBuffer *gy = inputs[1];

  if (gx->channels != 1 || gy->channels != 1) return CV_ERR_CHANNELS;
  if (gx->dtype != CV_DTYPE_F32 || gy->dtype != CV_DTYPE_F32) return CV_ERR_DTYPE;
  if (gx->width != gy->width || gx->height != gy->height) return CV_ERR_SHAPE;

  const char *range = cv_param_str(params, "range", "signed");
  const bool unsigned_range = (strcmp(range, "unsigned") == 0);
  if (!unsigned_range && strcmp(range, "signed") != 0) return CV_ERR_PARAM;

  CvStatus status = cv_buffer_alloc(out, gx->width, gx->height, 1,
                                    CV_DTYPE_F32, CV_SPACE_NONE);
  if (status != CV_OK) return status;

  const float *dx = f32(gx), *dy = f32(gy);
  float *dst = f32(out);
  const size_t n = cv_buffer_elements(gx);

  for (size_t i = 0; i < n; i++) {
    if ((i & 0xFFFF) == 0 && is_cancelled(ctx)) { cv_buffer_free(out); return CV_ERR_CANCELLED; }

    const double x = (double)dx[i], y = (double)dy[i];
    if (fabs(x) < CV_ORIENT_EPS && fabs(y) < CV_ORIENT_EPS) {
      dst[i] = 0.0f;                 /* no gradient, so no direction */
      continue;
    }
    double angle = atan2(y, x);      /* (-pi, pi] */
    if (unsigned_range) {
      /*
       * Fold onto [0, pi). A plain `if (angle < 0) angle += pi` looks right
       * and is not: atan2 returns exactly +pi for a gradient pointing along
       * -x, which is not negative, so it survives the test and lands outside
       * the range. Modulo first, then correct the sign.
       */
      angle = fmod(angle, CV_PI);
      if (angle < 0.0) angle += CV_PI;
    }
    dst[i] = (float)angle;
  }
  return CV_OK;
}

/* ------------------------------------------------------------------ */
/* segments(mag, gx, gy) -- straight edges, grown then fitted           */
/*                                                                      */
/* Region growing on gradient DIRECTION, in the spirit of LSD: pixels   */
/* of one straight edge point the same way, so they can be collected    */
/* into one region. Straightness is then enforced by orthogonal         */
/* regression -- total least squares -- with a pixel refused when its   */
/* perpendicular distance to the region's fitted line exceeds a         */
/* tolerance.                                                           */
/*                                                                      */
/* TLS rather than ordinary least squares because OLS minimises VERTICAL*/
/* residuals and so degenerates as a line approaches vertical. TLS      */
/* minimises perpendicular distance and is rotation-invariant, which an */
/* edge at an arbitrary angle requires.                                 */
/*                                                                      */
/* Directions are compared by dot product of unit gradient vectors, not */
/* by subtracting angles: no wraparound, no convention to keep in step  */
/* with whoever produced the field.                                     */
/* ------------------------------------------------------------------ */

/* Running sums for incremental TLS. Adding a point is O(1); the line is
 * recovered in closed form from the 2x2 covariance, so refitting after every
 * addition costs nothing. */
typedef struct { double n, sx, sy, sxx, syy, sxy; } CvTls;

static void tls_add(CvTls *t, double x, double y) {
  t->n += 1.0; t->sx += x; t->sy += y;
  t->sxx += x * x; t->syy += y * y; t->sxy += x * y;
}

/* Unit normal (nx, ny) and offset c, so that nx*x + ny*y + c = 0 is the line. */
static void tls_line(const CvTls *t, double *nx, double *ny, double *c) {
  const double mx = t->sx / t->n, my = t->sy / t->n;
  const double cxx = t->sxx / t->n - mx * mx;
  const double cyy = t->syy / t->n - my * my;
  const double cxy = t->sxy / t->n - mx * my;
  const double theta = 0.5 * atan2(2.0 * cxy, cxx - cyy);
  *nx = -sin(theta);
  *ny = cos(theta);
  *c = -(*nx * mx + *ny * my);
}

static double tls_distance(double nx, double ny, double c, double x, double y) {
  return fabs(nx * x + ny * y + c);
}

typedef struct { double magnitude; int64_t index; } CvSeed;

static int seed_compare(const void *a, const void *b) {
  const CvSeed *p = (const CvSeed *)a, *q = (const CvSeed *)b;
  /* Strongest first. Ties broken by index so the order is a total order and
   * cannot depend on the sort implementation. */
  if (p->magnitude > q->magnitude) return -1;
  if (p->magnitude < q->magnitude) return 1;
  return (p->index < q->index) ? -1 : (p->index > q->index);
}

static CvStatus k_segments(const CvBuffer *const *inputs, size_t n_inputs,
                           const CvParams *params, CvBuffer *out,
                           CvScalars *scalars, const CvKernelCtx *ctx) {
  (void)n_inputs; (void)scalars;
  const CvBuffer *mag = inputs[0];
  const CvBuffer *gx = inputs[1];
  const CvBuffer *gy = inputs[2];

  if (mag->channels != 1 || gx->channels != 1 || gy->channels != 1) return CV_ERR_CHANNELS;
  if (mag->dtype != CV_DTYPE_F32 || gx->dtype != CV_DTYPE_F32 || gy->dtype != CV_DTYPE_F32) {
    return CV_ERR_DTYPE;
  }
  if (gx->width != mag->width || gx->height != mag->height ||
      gy->width != mag->width || gy->height != mag->height) {
    return CV_ERR_SHAPE;
  }

  const double angle_tol = cv_param_num(params, "angleTol", 22.5);
  const double min_mag = cv_param_num(params, "minMag", 0.005);
  const double max_residual = cv_param_num(params, "maxResidual", 1.0);
  const int64_t min_pixels = (int64_t)cv_param_num(params, "minPixels", 8);
  const char *polarity = cv_param_str(params, "polarity", "signed");
  const bool ignore_polarity = (strcmp(polarity, "unsigned") == 0);
  if (!ignore_polarity && strcmp(polarity, "signed") != 0) return CV_ERR_PARAM;
  if (angle_tol <= 0.0 || angle_tol > 90.0 || max_residual <= 0.0 || min_pixels < 2) {
    return CV_ERR_PARAM;
  }
  const double cos_tol = cos(angle_tol * CV_PI / 180.0);

  const int64_t rows = mag->height, cols = mag->width;
  if (rows < 3 || cols < 3) return CV_ERR_DIMS;

  CvStatus status = cv_buffer_alloc(out, cols, rows, 1, CV_DTYPE_I32, CV_SPACE_NONE);
  if (status != CV_OK) return status;

  const float *m = f32(mag), *dx = f32(gx), *dy = f32(gy);
  int32_t *label = (int32_t *)out->data;
  const size_t n = (size_t)rows * (size_t)cols;

  /*
   * Candidates, excluding a one-pixel border: reflect-padding fabricates
   * neighbours that are not there, so the gradient -- and therefore the
   * direction -- is wrong at the image edge. Measured: on a diagonal edge the
   * interior orientation spread is 0.00 degrees and the whole-image spread is
   * 53, entirely from the boundary.
   */
  size_t candidate_count = 0;
  for (int64_t y = 1; y < rows - 1; y++) {
    for (int64_t x = 1; x < cols - 1; x++) {
      if ((double)m[y * cols + x] >= min_mag) candidate_count++;
    }
  }
  if (candidate_count == 0) return CV_OK;   /* a blank field is not an error */

  CvSeed *seeds = (CvSeed *)malloc(candidate_count * sizeof(CvSeed));
  int64_t *stack = (int64_t *)malloc(candidate_count * sizeof(int64_t));
  int64_t *members = (int64_t *)malloc(candidate_count * sizeof(int64_t));
  if (seeds == NULL || stack == NULL || members == NULL) {
    free(seeds); free(stack); free(members);
    cv_buffer_free(out);
    return CV_ERR_ALLOC;
  }

  size_t s = 0;
  for (int64_t y = 1; y < rows - 1; y++) {
    for (int64_t x = 1; x < cols - 1; x++) {
      const int64_t i = y * cols + x;
      if ((double)m[i] >= min_mag) {
        seeds[s].magnitude = (double)m[i];
        seeds[s].index = i;
        s++;
      }
    }
  }
  /* Strongest edges seeded first, so a region starts from its most confident
   * pixel rather than from wherever a raster scan happened to land. */
  qsort(seeds, candidate_count, sizeof(CvSeed), seed_compare);

  int32_t region = 0;
  for (size_t k = 0; k < candidate_count; k++) {
    if ((k & 0x3FF) == 0 && is_cancelled(ctx)) {
      free(seeds); free(stack); free(members);
      cv_buffer_free(out);
      return CV_ERR_CANCELLED;
    }

    const int64_t seed = seeds[k].index;
    if (label[seed] != 0) continue;

    region++;
    CvTls fit;
    memset(&fit, 0, sizeof(fit));

    /* The region's direction, accumulated as a vector sum rather than an
     * average of angles -- averaging angles is meaningless across a wrap. */
    double dirx = 0.0, diry = 0.0;

    size_t top = 0, count = 0;
    label[seed] = region;
    stack[top++] = seed;
    members[count++] = seed;
    {
      const double len = hypot((double)dx[seed], (double)dy[seed]);
      if (len > 0.0) { dirx += dx[seed] / len; diry += dy[seed] / len; }
      tls_add(&fit, (double)(seed % cols), (double)(seed / cols));
    }

    while (top > 0) {
      const int64_t current = stack[--top];
      const int64_t cy = current / cols, cx = current % cols;

      for (int64_t ny = cy - 1; ny <= cy + 1; ny++) {
        for (int64_t nx2 = cx - 1; nx2 <= cx + 1; nx2++) {
          if (ny < 1 || nx2 < 1 || ny >= rows - 1 || nx2 >= cols - 1) continue;
          const int64_t j = ny * cols + nx2;
          if (label[j] != 0) continue;
          if ((double)m[j] < min_mag) continue;

          /* Direction agreement, by dot product of unit vectors. */
          const double len = hypot((double)dx[j], (double)dy[j]);
          if (len <= 0.0) continue;
          double ux = dx[j] / len, uy = dy[j] / len;
          const double rlen = hypot(dirx, diry);
          if (rlen <= 0.0) continue;
          double agreement = (ux * dirx + uy * diry) / rlen;

          /*
           * With polarity=unsigned, a gradient pointing the opposite way is
           * the same edge seen from its other side. Flip the contribution to
           * match the region before testing, or the vector sum would cancel
           * itself out. This is what lets a boundary between alternating
           * blocks -- a checkerboard -- grow as one line instead of breaking
           * wherever the contrast reverses.
           */
          if (ignore_polarity && agreement < 0.0) {
            agreement = -agreement;
            ux = -ux; uy = -uy;
          }
          if (agreement < cos_tol) continue;

          /* Straightness: the new pixel must lie close to the line fitted to
           * what the region already contains. Only meaningful once there are
           * enough points to define one. */
          if (fit.n >= 3.0) {
            double lnx, lny, lc;
            tls_line(&fit, &lnx, &lny, &lc);
            if (tls_distance(lnx, lny, lc, (double)nx2, (double)ny) > max_residual) continue;
          }

          label[j] = region;
          stack[top++] = j;
          members[count++] = j;
          dirx += ux; diry += uy;
          tls_add(&fit, (double)nx2, (double)ny);
        }
      }
    }

    /* Too small to be an edge: give the pixels back, so they can join another
     * region rather than being stranded. */
    if ((int64_t)count < min_pixels) {
      for (size_t i = 0; i < count; i++) label[members[i]] = 0;
      region--;
    }
  }

  free(seeds); free(stack); free(members);

  /*
   * Renumber canonically.
   *
   * Growing order depends on magnitude ordering, which is not guaranteed
   * identical across platforms in its last bits. Two runs finding the SAME
   * regions but numbering them differently would produce different content
   * hashes and a replay would report a change that did not happen. So the
   * final numbering is derived from the image alone: regions are numbered in
   * raster order of their first pixel.
   */
  if (region > 0) {
    int32_t *renumber = (int32_t *)calloc((size_t)region + 1, sizeof(int32_t));
    if (renumber == NULL) { cv_buffer_free(out); return CV_ERR_ALLOC; }
    int32_t next = 0;
    for (size_t i = 0; i < n; i++) {
      const int32_t old = label[i];
      if (old == 0) continue;
      if (renumber[old] == 0) renumber[old] = ++next;
      label[i] = renumber[old];
    }
    free(renumber);
  }
  return CV_OK;
}
