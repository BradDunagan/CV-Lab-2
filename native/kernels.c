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
/* the table                                                            */
/* ------------------------------------------------------------------ */

static const CvKernelEntry KERNELS[] = {
  { "pattern",   k_pattern,   0, true  },
  { "gray",      k_gray,      1, true  },
  { "gaussian",  k_gaussian,  1, true  },
  { "sobel",     k_sobel,     1, true  },
  { "threshold", k_threshold, 1, true  },
  { "stats",     k_stats,     1, false },
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
