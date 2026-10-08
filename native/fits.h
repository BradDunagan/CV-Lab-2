/*
 * fits.h — the results that are not pixels, computed in plain C.
 *
 * These lived in addon_kernels.c and addon_buffer.c, written straight into
 * Node-API objects. That made them reachable from one host only. Moved here
 * they are what every surface calls -- the Node-API addon and the WebAssembly
 * module alike -- so both run the same C and differ only in how the result
 * is handed to JavaScript. Nothing in this file knows about either.
 *
 * Not `features.h`, which it was for an hour: musl's and glibc's stdlib.h
 * both include <features.h>, and with native/ on the include path the
 * angle-bracket search found this file first. wasi-libc failed loudly; a
 * Linux addon build would have too.
 */
#ifndef CVLAB_FITS_H
#define CVLAB_FITS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "buffer.h"

/* One straight edge: fitSegments' record, field for field. */
typedef struct {
  int32_t id;
  int64_t pixels;
  double x0, y0, x1, y1, length, angle, residual, rms, cx, cy;
} CvSegmentFit;

/* One circular arc candidate: fitArcs' record, field for field. */
typedef struct {
  int32_t id;
  int64_t pixels;
  double cx, cy, r, x0, y0, x1, y1, angle0, angle1, sweep, arc_length, chord,
      sagitta, residual, rms, line_rms, mx, my;
} CvArcFit;

/*
 * Geometry out of an i32 label map. On CV_OK `*out` holds `*count` records,
 * in label order, and is the caller's to free(); it may be NULL when the
 * count is zero. CV_ERR_DTYPE and CV_ERR_CHANNELS say the buffer is not a
 * one-channel i32 map.
 */
CvStatus cv_fit_segments(const CvBuffer *labels, CvSegmentFit **out, size_t *count);
CvStatus cv_fit_arcs(const CvBuffer *labels, CvArcFit **out, size_t *count);

/*
 * A 3-channel f32 buffer from 8-bit RGBA, alpha dropped. `from_linear` says
 * what the bytes mean, `as_linear` what the buffer holds; a difference is
 * applied by an exact 256-entry table. `length` is the byte count, checked
 * against width * height * 4: CV_ERR_SHAPE when they disagree.
 */
CvStatus cv_buffer_from_rgba8(CvBuffer *out, const uint8_t *rgba, size_t length,
                              int64_t width, int64_t height, bool from_linear,
                              bool as_linear);

#endif /* CVLAB_FITS_H */
