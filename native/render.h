/*
 * render.h — turning a buffer into something a screen can show.
 *
 * design-lab-model.md §6 and §8. Two jobs:
 *
 *   1. Apply a display transform — range, curve, colormap, channel — none of
 *      which touch the buffer. They change how it is drawn, never what it
 *      contains.
 *   2. Do the downsampling HERE, in C, so that only display-resolution RGBA
 *      crosses into JavaScript. A 12 MP slot rendered into an 800x600 tile is
 *      ~1.9 MB out rather than 48 MB.
 */
#ifndef CVLAB_RENDER_H
#define CVLAB_RENDER_H

#include <stdint.h>

#include "buffer.h"

typedef enum {
  CV_RANGE_AUTO = 0,     /* the actual min and max */
  CV_RANGE_FIXED,        /* caller-supplied lo and hi */
  CV_RANGE_PERCENTILE,   /* ignore the tails; outlier-resistant */
  CV_RANGE_SYMMETRIC     /* [-m, +m]; puts zero on the neutral midpoint */
} CvRangeMode;

typedef enum {
  CV_CURVE_LINEAR = 0,
  CV_CURVE_LOG,          /* for data spanning orders of magnitude */
  CV_CURVE_ABS,          /* magnitude, discarding sign */
  CV_CURVE_SQRT          /* gentler than log */
} CvCurve;

typedef enum {
  CV_MAP_GRAY = 0,
  CV_MAP_VIRIDIS,        /* perceptually uniform, colourblind-safe */
  CV_MAP_TURBO,          /* more discriminable, NOT lightness-monotonic */
  CV_MAP_DIVERGING,      /* two hues meeting at a neutral midpoint */
  CV_MAP_CATEGORICAL,    /* labels: distinct, unordered, never interpolated */
  CV_MAP_CYCLIC          /* angles: wraps, so the two ends meet */
} CvColormap;

typedef struct {
  /* destination size, in display pixels */
  int64_t width, height;
  /* source region, in buffer coordinates; width 0 means "the whole buffer" */
  CvRect src;

  CvRangeMode range;
  double lo, hi;              /* used when range is FIXED */
  double percentile;          /* e.g. 2.0 for the 2..98 band */

  CvCurve curve;
  CvColormap colormap;
  int32_t channel;            /* -1 = composite (RGB shown as colour) */
  /*
   * When magnifying: interpolate (smooth) or take the nearest sample (crisp,
   * showing true pixel boundaries). Neither is right for every purpose --
   * smooth preserves antialiasing already in the data, nearest shows what is
   * actually stored. Labels ignore this and are always nearest.
   */
  bool interpolate;
} CvRenderSpec;

typedef struct {
  double lo, hi;              /* the range actually used, after the curve */
  int64_t width, height;
} CvRenderResult;

/*
 * Writes width*height*4 bytes of RGBA into `rgba`, which the caller owns.
 * `out` reports the resolved range so the UI can label the scale.
 */
CvStatus cv_render(const CvBuffer *src, const CvRenderSpec *spec,
                   uint8_t *rgba, CvRenderResult *out);

/* Histogram of the curved values over the same range logic as cv_render. */
CvStatus cv_histogram(const CvBuffer *src, const CvRenderSpec *spec,
                      int32_t *counts, int64_t bins, CvRenderResult *out);

/* Single-pixel readout for the probe, in buffer coordinates. */
CvStatus cv_sample(const CvBuffer *src, int64_t x, int64_t y,
                   double *values, int32_t *n_values);

#endif /* CVLAB_RENDER_H */
