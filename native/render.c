#include "render.h"

#include <math.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/* colormaps                                                            */
/*                                                                      */
/* Stop lists interpolated linearly. viridis and turbo are sampled       */
/* approximations of the published maps -- close enough to preserve the  */
/* properties that matter (viridis monotonic in lightness, turbo more    */
/* discriminable) without embedding 256-entry tables.                    */
/* ------------------------------------------------------------------ */

typedef struct { float r, g, b; } Rgb;

static const Rgb VIRIDIS[] = {
  {0.267f,0.005f,0.329f},{0.282f,0.157f,0.471f},{0.243f,0.290f,0.538f},
  {0.192f,0.408f,0.556f},{0.149f,0.510f,0.557f},{0.122f,0.620f,0.537f},
  {0.208f,0.718f,0.475f},{0.427f,0.804f,0.349f},{0.706f,0.871f,0.173f},
  {0.992f,0.906f,0.145f},
};

static const Rgb TURBO[] = {
  {0.188f,0.071f,0.231f},{0.255f,0.271f,0.671f},{0.275f,0.459f,0.929f},
  {0.224f,0.635f,0.988f},{0.106f,0.812f,0.831f},{0.141f,0.925f,0.651f},
  {0.380f,0.988f,0.424f},{0.643f,0.988f,0.231f},{0.820f,0.910f,0.204f},
  {0.984f,0.502f,0.133f},{0.478f,0.016f,0.012f},
};

/* Blue -> near-white -> red. Centred, which is what makes it honest. */
static const Rgb DIVERGING[] = {
  {0.129f,0.400f,0.675f},{0.969f,0.969f,0.969f},{0.698f,0.094f,0.169f},
};

/* Unordered and distinct. Index 0 is reserved for background. */
static const Rgb CATEGORICAL[] = {
  {0.000f,0.000f,0.000f},{0.894f,0.102f,0.110f},{0.216f,0.494f,0.722f},
  {0.302f,0.686f,0.290f},{0.596f,0.306f,0.639f},{1.000f,0.498f,0.000f},
  {1.000f,1.000f,0.200f},{0.651f,0.337f,0.157f},{0.969f,0.506f,0.749f},
  {0.600f,0.600f,0.600f},{0.400f,0.761f,0.647f},{0.988f,0.553f,0.384f},
};

static Rgb sample_stops(const Rgb *stops, size_t count, double t) {
  if (t <= 0.0) return stops[0];
  if (t >= 1.0) return stops[count - 1];
  const double scaled = t * (double)(count - 1);
  const size_t i = (size_t)scaled;
  const double f = scaled - (double)i;
  const Rgb a = stops[i], b = stops[i + 1 < count ? i + 1 : i];
  Rgb out;
  out.r = (float)(a.r + (b.r - a.r) * f);
  out.g = (float)(a.g + (b.g - a.g) * f);
  out.b = (float)(a.b + (b.b - a.b) * f);
  return out;
}

static Rgb apply_colormap(CvColormap map, double t, double raw) {
  switch (map) {
    case CV_MAP_VIRIDIS:   return sample_stops(VIRIDIS, sizeof(VIRIDIS)/sizeof(Rgb), t);
    case CV_MAP_TURBO:     return sample_stops(TURBO, sizeof(TURBO)/sizeof(Rgb), t);
    case CV_MAP_DIVERGING: return sample_stops(DIVERGING, sizeof(DIVERGING)/sizeof(Rgb), t);
    case CV_MAP_CATEGORICAL: {
      /* Labels are names, not magnitudes: index by value, never interpolate. */
      const size_t count = sizeof(CATEGORICAL) / sizeof(Rgb);
      int64_t label = (int64_t)llround(raw);
      if (label <= 0) return CATEGORICAL[0];
      return CATEGORICAL[1 + (size_t)((label - 1) % (int64_t)(count - 1))];
    }
    case CV_MAP_GRAY:
    default: {
      Rgb out; out.r = out.g = out.b = (float)t; return out;
    }
  }
}

/* ------------------------------------------------------------------ */
/* value access and the display curve                                   */
/* ------------------------------------------------------------------ */

/*
 * Bilinear sample at a fractional source coordinate, edges clamped.
 *
 * Used when MAGNIFYING continuous data. Without it a magnified tile is
 * nearest-neighbour -- the box filter degenerates to one sample once a
 * destination pixel maps to less than a source pixel -- so a 128x128 image
 * shown at 420x420 renders every source pixel as a hard 3.3-pixel block, and
 * antialiasing already present in the data is thrown away on the way to the
 * screen.
 *
 * Labels are excluded: interpolating between label 3 and label 9 gives 6,
 * a region that may not exist (§6).
 */
static double element_at(const CvBuffer *b, int64_t x, int64_t y, int32_t c);

static double sample_bilinear(const CvBuffer *b, double x, double y, int32_t c,
                              const CvRect *rect) {
  const int64_t x0 = (int64_t)floor(x);
  const int64_t y0 = (int64_t)floor(y);
  const double fx = x - (double)x0;
  const double fy = y - (double)y0;

  const int64_t lo_x = rect->x, hi_x = rect->x + rect->width - 1;
  const int64_t lo_y = rect->y, hi_y = rect->y + rect->height - 1;

  const int64_t xa = x0 < lo_x ? lo_x : (x0 > hi_x ? hi_x : x0);
  const int64_t xb = (x0 + 1) < lo_x ? lo_x : ((x0 + 1) > hi_x ? hi_x : (x0 + 1));
  const int64_t ya = y0 < lo_y ? lo_y : (y0 > hi_y ? hi_y : y0);
  const int64_t yb = (y0 + 1) < lo_y ? lo_y : ((y0 + 1) > hi_y ? hi_y : (y0 + 1));

  const double top = element_at(b, xa, ya, c) * (1.0 - fx) + element_at(b, xb, ya, c) * fx;
  const double bottom = element_at(b, xa, yb, c) * (1.0 - fx) + element_at(b, xb, yb, c) * fx;
  return top * (1.0 - fy) + bottom * fy;
}

static double element_at(const CvBuffer *b, int64_t x, int64_t y, int32_t c) {
  const size_t index = (size_t)((y * b->width + x) * b->channels + c);
  return (b->dtype == CV_DTYPE_I32) ? (double)((const int32_t *)b->data)[index]
                                    : (double)((const float *)b->data)[index];
}

/*
 * The curve is applied to the VALUE, before the range is computed. That is
 * what makes `log` useful on an FFT magnitude: the range then spans the
 * compressed values rather than the raw ones. A fixed lo/hi is passed through
 * the same curve, so the caller always states them in data units.
 */
static double apply_curve(CvCurve curve, double v) {
  switch (curve) {
    case CV_CURVE_ABS:  return fabs(v);
    case CV_CURVE_SQRT: return (v < 0.0) ? -sqrt(-v) : sqrt(v);
    case CV_CURVE_LOG: {
      const double a = log1p(fabs(v));   /* log1p, so v == 0 is defined */
      return (v < 0.0) ? -a : a;
    }
    case CV_CURVE_LINEAR:
    default: return v;
  }
}

static void resolve_src(const CvBuffer *src, const CvRenderSpec *spec, CvRect *out) {
  CvRect r = spec->src;
  if (r.width <= 0 || r.height <= 0) {
    r.x = 0; r.y = 0; r.width = src->width; r.height = src->height;
  }
  if (r.x < 0) r.x = 0;
  if (r.y < 0) r.y = 0;
  if (r.x + r.width > src->width) r.width = src->width - r.x;
  if (r.y + r.height > src->height) r.height = src->height - r.y;
  *out = r;
}

/* ------------------------------------------------------------------ */
/* range resolution                                                     */
/* ------------------------------------------------------------------ */

#define CV_HIST_BINS 1024

static void resolve_range(const CvBuffer *src, const CvRenderSpec *spec,
                          const CvRect *rect, int32_t channel,
                          double *out_lo, double *out_hi) {
  if (spec->range == CV_RANGE_FIXED) {
    *out_lo = apply_curve(spec->curve, spec->lo);
    *out_hi = apply_curve(spec->curve, spec->hi);
    if (*out_hi <= *out_lo) *out_hi = *out_lo + 1e-12;
    return;
  }

  const int32_t c0 = (channel >= 0) ? channel : 0;
  const int32_t c1 = (channel >= 0) ? channel + 1 : src->channels;

  double lo = INFINITY, hi = -INFINITY;
  for (int64_t y = rect->y; y < rect->y + rect->height; y++) {
    for (int64_t x = rect->x; x < rect->x + rect->width; x++) {
      for (int32_t c = c0; c < c1; c++) {
        const double v = apply_curve(spec->curve, element_at(src, x, y, c));
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (!isfinite(lo) || !isfinite(hi)) { lo = 0.0; hi = 1.0; }

  if (spec->range == CV_RANGE_PERCENTILE && hi > lo) {
    /* One histogram pass, then walk in from both ends. Outlier-resistant
     * without needing to sort. */
    int64_t counts[CV_HIST_BINS];
    memset(counts, 0, sizeof(counts));
    int64_t total = 0;
    const double scale = (double)(CV_HIST_BINS - 1) / (hi - lo);
    for (int64_t y = rect->y; y < rect->y + rect->height; y++) {
      for (int64_t x = rect->x; x < rect->x + rect->width; x++) {
        for (int32_t c = c0; c < c1; c++) {
          const double v = apply_curve(spec->curve, element_at(src, x, y, c));
          int64_t bin = (int64_t)((v - lo) * scale);
          if (bin < 0) bin = 0;
          if (bin >= CV_HIST_BINS) bin = CV_HIST_BINS - 1;
          counts[bin]++;
          total++;
        }
      }
    }
    const double fraction = (spec->percentile > 0.0 ? spec->percentile : 2.0) / 100.0;
    const int64_t drop = (int64_t)((double)total * fraction);
    int64_t seen = 0, low_bin = 0, high_bin = CV_HIST_BINS - 1;
    for (int64_t i = 0; i < CV_HIST_BINS; i++) {
      seen += counts[i];
      if (seen > drop) { low_bin = i; break; }
    }
    seen = 0;
    for (int64_t i = CV_HIST_BINS - 1; i >= 0; i--) {
      seen += counts[i];
      if (seen > drop) { high_bin = i; break; }
    }
    const double width = (hi - lo) / (double)(CV_HIST_BINS - 1);
    double new_lo = lo + (double)low_bin * width;
    double new_hi = lo + (double)high_bin * width;
    /*
     * A far outlier can push every other value into a single bin, collapsing
     * the band to zero width. Falling back to the full range there would
     * defeat the whole point of percentile clipping, so widen to one bin
     * instead -- that bin IS where the data lives.
     */
    if (new_hi <= new_lo) new_hi = new_lo + width;
    lo = new_lo;
    hi = new_hi;
  }

  if (spec->range == CV_RANGE_SYMMETRIC) {
    /* Zero must land exactly on the midpoint, or a diverging map misreports
     * sign -- §6. */
    const double m = fmax(fabs(lo), fabs(hi));
    lo = -m; hi = m;
  }

  if (hi <= lo) hi = lo + 1e-12;
  *out_lo = lo;
  *out_hi = hi;
}

/* ------------------------------------------------------------------ */
/* rendering                                                            */
/* ------------------------------------------------------------------ */

CvStatus cv_render(const CvBuffer *src, const CvRenderSpec *spec,
                   uint8_t *rgba, CvRenderResult *out) {
  if (src == NULL || src->data == NULL || spec == NULL || rgba == NULL) return CV_ERR_DIMS;
  if (spec->width <= 0 || spec->height <= 0) return CV_ERR_DIMS;

  CvRect rect;
  resolve_src(src, spec, &rect);
  if (rect.width <= 0 || rect.height <= 0) return CV_ERR_DIMS;

  const bool composite = (spec->channel < 0 && src->channels == 3);
  const int32_t channel = composite ? -1
                        : (spec->channel < 0 ? 0
                        : (spec->channel < src->channels ? spec->channel : src->channels - 1));

  double lo, hi;
  resolve_range(src, spec, &rect, composite ? -1 : channel, &lo, &hi);
  const double span = hi - lo;

  /*
   * Labels must never be interpolated (§6), so a categorical map or an i32
   * buffer samples nearest-neighbour. Continuous data is box-averaged, which
   * matters a great deal when a 12 MP slot is shown in an 800 px tile.
   */
  const bool nearest = (spec->colormap == CV_MAP_CATEGORICAL) || (src->dtype == CV_DTYPE_I32);

  /*
   * Three sampling regimes, and the choice matters more than it looks:
   *   labels          -> nearest, always
   *   minifying       -> box average, so detail is not dropped on the floor
   *   magnifying      -> bilinear, so antialiasing in the data survives
   */
  /* >= rather than >: at exactly 1:1 the sample centres land on integer
   * coordinates, so bilinear returns the exact source value anyway, and a
   * single-row or single-column buffer is not excluded by its own axis. */
  const bool magnifying = !nearest && spec->interpolate &&
      (spec->width >= rect.width) && (spec->height >= rect.height);

  for (int64_t dy = 0; dy < spec->height; dy++) {
    const double sy0 = rect.y + (double)dy * rect.height / (double)spec->height;
    const double sy1 = rect.y + (double)(dy + 1) * rect.height / (double)spec->height;

    for (int64_t dx = 0; dx < spec->width; dx++) {
      const double sx0 = rect.x + (double)dx * rect.width / (double)spec->width;
      const double sx1 = rect.x + (double)(dx + 1) * rect.width / (double)spec->width;

      int64_t y0 = (int64_t)sy0, y1 = (int64_t)ceil(sy1);
      int64_t x0 = (int64_t)sx0, x1 = (int64_t)ceil(sx1);
      if (y1 <= y0) y1 = y0 + 1;
      if (x1 <= x0) x1 = x0 + 1;
      if (y1 > rect.y + rect.height) y1 = rect.y + rect.height;
      if (x1 > rect.x + rect.width) x1 = rect.x + rect.width;

      /* Centre of this destination pixel, in source coordinates. */
      const double cx = (sx0 + sx1) * 0.5 - 0.5;
      const double cy = (sy0 + sy1) * 0.5 - 0.5;

      Rgb colour;
      if (composite) {
        double acc[3] = {0, 0, 0};
        int64_t n = 1;
        if (nearest) {
          for (int32_t c = 0; c < 3; c++) acc[c] = element_at(src, x0, y0, c);
        } else if (magnifying) {
          for (int32_t c = 0; c < 3; c++) acc[c] = sample_bilinear(src, cx, cy, c, &rect);
        } else {
          acc[0] = acc[1] = acc[2] = 0.0;
          n = 0;
          for (int64_t y = y0; y < y1; y++)
            for (int64_t x = x0; x < x1; x++) {
              for (int32_t c = 0; c < 3; c++) acc[c] += element_at(src, x, y, c);
              n++;
            }
        }
        float rgb3[3];
        for (int32_t c = 0; c < 3; c++) {
          const double v = apply_curve(spec->curve, acc[c] / (double)(n ? n : 1));
          const double t = (v - lo) / span;
          rgb3[c] = (float)(t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t));
        }
        colour.r = rgb3[0]; colour.g = rgb3[1]; colour.b = rgb3[2];
      } else {
        double raw;
        if (nearest) {
          raw = element_at(src, x0, y0, channel);
        } else if (magnifying) {
          raw = sample_bilinear(src, cx, cy, channel, &rect);
        } else {
          double acc = 0.0;
          int64_t n = 0;
          for (int64_t y = y0; y < y1; y++)
            for (int64_t x = x0; x < x1; x++) { acc += element_at(src, x, y, channel); n++; }
          raw = acc / (double)(n ? n : 1);
        }
        const double v = apply_curve(spec->curve, raw);
        double t = (v - lo) / span;
        if (t < 0.0) t = 0.0;
        if (t > 1.0) t = 1.0;
        colour = apply_colormap(spec->colormap, t, raw);
      }

      uint8_t *px = rgba + (size_t)(dy * spec->width + dx) * 4;
      px[0] = (uint8_t)lround(fmin(fmax(colour.r, 0.0f), 1.0f) * 255.0);
      px[1] = (uint8_t)lround(fmin(fmax(colour.g, 0.0f), 1.0f) * 255.0);
      px[2] = (uint8_t)lround(fmin(fmax(colour.b, 0.0f), 1.0f) * 255.0);
      px[3] = 255;
    }
  }

  if (out != NULL) { out->lo = lo; out->hi = hi; out->width = spec->width; out->height = spec->height; }
  return CV_OK;
}

/* ------------------------------------------------------------------ */

CvStatus cv_histogram(const CvBuffer *src, const CvRenderSpec *spec,
                      int32_t *counts, int64_t bins, CvRenderResult *out) {
  if (src == NULL || src->data == NULL || counts == NULL || bins <= 0) return CV_ERR_DIMS;

  CvRect rect;
  resolve_src(src, spec, &rect);

  const int32_t channel = (spec->channel < 0) ? -1
                        : (spec->channel < src->channels ? spec->channel : 0);
  double lo, hi;
  resolve_range(src, spec, &rect, channel, &lo, &hi);

  memset(counts, 0, (size_t)bins * sizeof(int32_t));
  const double scale = (double)(bins - 1) / (hi - lo);
  const int32_t c0 = (channel >= 0) ? channel : 0;
  const int32_t c1 = (channel >= 0) ? channel + 1 : src->channels;

  for (int64_t y = rect.y; y < rect.y + rect.height; y++) {
    for (int64_t x = rect.x; x < rect.x + rect.width; x++) {
      for (int32_t c = c0; c < c1; c++) {
        const double v = apply_curve(spec->curve, element_at(src, x, y, c));
        int64_t bin = (int64_t)((v - lo) * scale);
        if (bin < 0) bin = 0;
        if (bin >= bins) bin = bins - 1;
        counts[bin]++;
      }
    }
  }

  if (out != NULL) { out->lo = lo; out->hi = hi; out->width = bins; out->height = 1; }
  return CV_OK;
}

CvStatus cv_sample(const CvBuffer *src, int64_t x, int64_t y,
                   double *values, int32_t *n_values) {
  if (src == NULL || src->data == NULL || values == NULL) return CV_ERR_DIMS;
  if (x < 0 || y < 0 || x >= src->width || y >= src->height) return CV_ERR_DIMS;
  for (int32_t c = 0; c < src->channels; c++) values[c] = element_at(src, x, y, c);
  if (n_values) *n_values = src->channels;
  return CV_OK;
}
