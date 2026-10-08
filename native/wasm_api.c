/*
 * wasm_api.c — the WebAssembly surface: the addon_*.c files' counterpart
 * for a host with no Node-API, which is a browser and anything that wants
 * the same module a browser runs.
 *
 * Flat functions only. A buffer handle is its CvBuffer's address; numbers
 * are i32 or f64, so no BigInt crosses (dimensions are capped at 2^20 and a
 * wasm32 byte count fits a double exactly); strings arrive as NUL-terminated
 * UTF-8 the caller wrote into memory from cvw_malloc. Feature records go out
 * as flat f64 arrays, a fixed number per record, because a struct's padding
 * is the compiler's business and a reader in JavaScript should not depend
 * on it. A call that fails returns 0 or -1 and leaves its CvStatus for
 * cvw_last_status(); native/wasm.js turns that into the error the addon
 * throws, message for message.
 *
 * Everything that computes is elsewhere -- kernels.c, render.c, fits.c
 * -- and is the same C the addon calls. This file only moves values.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "buffer.h"
#include "fits.h"
#include "kernels.h"
#include "render.h"
#include "sha256.h"

#if defined(__wasm__)
#define CVW_EXPORT(name) __attribute__((export_name(#name)))
#else
#define CVW_EXPORT(name) /* compiled natively only by lint:native */
#endif

static CvStatus last_status = CV_OK;

static int32_t fail(CvStatus status) { last_status = status; return -1; }

CVW_EXPORT(cvw_last_status) int32_t cvw_last_status(void) { return (int32_t)last_status; }

CVW_EXPORT(cvw_status_str) const char *cvw_status_str(int32_t status) {
  return cv_status_str((CvStatus)status);
}

CVW_EXPORT(cvw_malloc) void *cvw_malloc(size_t bytes) { return malloc(bytes > 0 ? bytes : 1); }

CVW_EXPORT(cvw_free) void cvw_free(void *ptr) { free(ptr); }

/* ------------------------------------------------------------------ */
/* buffers                                                              */
/* ------------------------------------------------------------------ */

CVW_EXPORT(cvw_buffer_create)
CvBuffer *cvw_buffer_create(double width, double height, int32_t channels,
                            int32_t dtype, int32_t space) {
  CvBuffer *buffer = (CvBuffer *)calloc(1, sizeof(CvBuffer));
  if (buffer == NULL) { last_status = CV_ERR_ALLOC; return NULL; }
  /* Doubles, so a width past 2^31 still reaches cv_buffer_alloc's own check
   * and is refused there, by the message the addon gives. */
  const CvStatus status = cv_buffer_alloc(buffer, (int64_t)width, (int64_t)height, channels,
                                          (CvDtype)dtype, (CvSpace)space);
  if (status != CV_OK) { free(buffer); last_status = status; return NULL; }
  return buffer;
}

CVW_EXPORT(cvw_buffer_width) double cvw_buffer_width(const CvBuffer *b) { return (double)b->width; }
CVW_EXPORT(cvw_buffer_height) double cvw_buffer_height(const CvBuffer *b) { return (double)b->height; }
CVW_EXPORT(cvw_buffer_channels) int32_t cvw_buffer_channels(const CvBuffer *b) { return b->channels; }
CVW_EXPORT(cvw_buffer_dtype) int32_t cvw_buffer_dtype(const CvBuffer *b) { return (int32_t)b->dtype; }
CVW_EXPORT(cvw_buffer_space) int32_t cvw_buffer_space(const CvBuffer *b) { return (int32_t)b->space; }
CVW_EXPORT(cvw_buffer_bytes) double cvw_buffer_bytes(const CvBuffer *b) { return (double)b->bytes; }
CVW_EXPORT(cvw_buffer_elements) double cvw_buffer_elements(const CvBuffer *b) {
  return (double)cv_buffer_elements(b);
}
CVW_EXPORT(cvw_buffer_data) void *cvw_buffer_data(const CvBuffer *b) { return b->data; }

/* Frees the pixels and keeps the struct, so a released handle still answers
 * bufferInfo (live: false) as the addon's does. Idempotent. */
CVW_EXPORT(cvw_buffer_release) void cvw_buffer_release(CvBuffer *b) { cv_buffer_free(b); }

/* The struct too: what the JS side's finalizer calls once a handle is gone. */
CVW_EXPORT(cvw_buffer_destroy) void cvw_buffer_destroy(CvBuffer *b) {
  if (b == NULL) return;
  cv_buffer_free(b);
  free(b);
}

/* The buffer's SHA-256 into `digest` (32 bytes): its content hash. */
CVW_EXPORT(cvw_buffer_sha256) void cvw_buffer_sha256(const CvBuffer *b, uint8_t *digest) {
  cv_sha256(b->data, b->bytes, digest);
}

CVW_EXPORT(cvw_buffer_from_rgba8)
CvBuffer *cvw_buffer_from_rgba8(const uint8_t *rgba, double length, double width,
                                double height, int32_t from_linear, int32_t as_linear) {
  CvBuffer *buffer = (CvBuffer *)calloc(1, sizeof(CvBuffer));
  if (buffer == NULL) { last_status = CV_ERR_ALLOC; return NULL; }
  const CvStatus status = cv_buffer_from_rgba8(buffer, rgba, (size_t)length, (int64_t)width,
                                               (int64_t)height, from_linear != 0, as_linear != 0);
  if (status != CV_OK) { free(buffer); last_status = status; return NULL; }
  return buffer;
}

/* ------------------------------------------------------------------ */
/* parameters -- built one at a time, as the addon's read_params does   */
/* from a JS object: names and strings truncated to the field, anything */
/* past CV_PARAMS_MAX refused                                           */
/* ------------------------------------------------------------------ */

CVW_EXPORT(cvw_params_new) CvParams *cvw_params_new(void) {
  return (CvParams *)calloc(1, sizeof(CvParams));
}

CVW_EXPORT(cvw_params_free) void cvw_params_free(CvParams *p) { free(p); }

static CvParam *next_param(CvParams *p, const char *name) {
  if (p->count >= CV_PARAMS_MAX) return NULL;
  CvParam *param = &p->items[p->count];
  memset(param, 0, sizeof(*param));
  strncpy(param->name, name, sizeof(param->name) - 1);
  return param;
}

CVW_EXPORT(cvw_params_number) int32_t cvw_params_number(CvParams *p, const char *name, double value) {
  CvParam *param = next_param(p, name);
  if (param == NULL) return fail(CV_ERR_PARAM);
  param->kind = CV_PARAM_NUMBER;
  param->number = value;
  p->count++;
  return 0;
}

CVW_EXPORT(cvw_params_bool) int32_t cvw_params_bool(CvParams *p, const char *name, int32_t value) {
  CvParam *param = next_param(p, name);
  if (param == NULL) return fail(CV_ERR_PARAM);
  param->kind = CV_PARAM_BOOL;
  param->boolean = value != 0;
  p->count++;
  return 0;
}

CVW_EXPORT(cvw_params_string) int32_t cvw_params_string(CvParams *p, const char *name, const char *value) {
  CvParam *param = next_param(p, name);
  if (param == NULL) return fail(CV_ERR_PARAM);
  param->kind = CV_PARAM_STRING;
  strncpy(param->string, value, sizeof(param->string) - 1);
  p->count++;
  return 0;
}

/* ------------------------------------------------------------------ */
/* kernels                                                              */
/* ------------------------------------------------------------------ */

CVW_EXPORT(cvw_kernel_count) int32_t cvw_kernel_count(void) { return (int32_t)cv_kernel_count(); }

CVW_EXPORT(cvw_kernel_name) const char *cvw_kernel_name(int32_t i) { return cv_kernel_at((size_t)i)->name; }

CVW_EXPORT(cvw_kernel_inputs) int32_t cvw_kernel_inputs(int32_t i) {
  return (int32_t)cv_kernel_at((size_t)i)->inputs;
}

CVW_EXPORT(cvw_kernel_produces_buffer) int32_t cvw_kernel_produces_buffer(int32_t i) {
  return cv_kernel_at((size_t)i)->produces_buffer ? 1 : 0;
}

/*
 * Runs kernel `index` (from cvw_kernel_count's numbering; the JS side looks
 * the name up and checks the input count, as the addon does). A kernel that
 * produces a buffer returns it; one that produces scalars writes min, max,
 * mean, stddev and count into `scalars` and returns NULL with the status
 * CV_OK. Failure is NULL with the status set.
 */
CVW_EXPORT(cvw_run_kernel)
CvBuffer *cvw_run_kernel(int32_t index, const CvBuffer *const *inputs, int32_t n_inputs,
                         const CvParams *params, double *scalars) {
  const CvKernelEntry *entry = cv_kernel_at((size_t)index);
  static const CvParams none = { .count = 0 };

  /* Cancellation is wired through as the addon wires it: nothing in a
   * single-threaded module can set the flag while a kernel runs. */
  volatile int cancel = 0;
  CvKernelCtx ctx = { .cancel = &cancel, .roi = { 0, 0, 0, 0 } };

  CvBuffer produced;
  memset(&produced, 0, sizeof(produced));
  CvScalars out;
  memset(&out, 0, sizeof(out));

  last_status = entry->fn(inputs, (size_t)n_inputs, params != NULL ? params : &none,
                          &produced, &out, &ctx);
  if (last_status != CV_OK) return NULL;

  if (!entry->produces_buffer) {
    scalars[0] = out.min;
    scalars[1] = out.max;
    scalars[2] = out.mean;
    scalars[3] = out.stddev;
    scalars[4] = (double)out.count;
    return NULL;
  }
  CvBuffer *heap = (CvBuffer *)calloc(1, sizeof(CvBuffer));
  if (heap == NULL) { cv_buffer_free(&produced); last_status = CV_ERR_ALLOC; return NULL; }
  *heap = produced;
  return heap;
}

/* ------------------------------------------------------------------ */
/* the display path                                                     */
/* ------------------------------------------------------------------ */

/*
 * The tile, malloc'd: width * height * 4 bytes of RGBA, which the caller
 * copies out and frees. `result` gets width, height, lo and hi. -1 when the
 * spec's size is refused (status CV_ERR_DIMS) or the render fails.
 */
CVW_EXPORT(cvw_render_tile)
uint8_t *cvw_render_tile(const CvBuffer *src, const CvParams *params, double *result) {
  CvRenderSpec spec;
  cv_render_spec_from_params(params, &spec);
  if (spec.width <= 0 || spec.height <= 0 || spec.width > 16384 || spec.height > 16384) {
    last_status = CV_ERR_DIMS;
    return NULL;
  }
  const size_t bytes = (size_t)spec.width * (size_t)spec.height * 4;
  uint8_t *dst = (uint8_t *)malloc(bytes);
  if (dst == NULL) { last_status = CV_ERR_ALLOC; return NULL; }
  CvRenderResult r;
  last_status = cv_render(src, &spec, dst, &r);
  if (last_status != CV_OK) { free(dst); return NULL; }
  result[0] = (double)r.width;
  result[1] = (double)r.height;
  result[2] = r.lo;
  result[3] = r.hi;
  return dst;
}

/* The counts, malloc'd, `*bins` of them; `result` gets lo and hi. */
CVW_EXPORT(cvw_histogram)
int32_t *cvw_histogram(const CvBuffer *src, const CvParams *params, double *result, int32_t *bins) {
  CvRenderSpec spec;
  cv_render_spec_from_params(params, &spec);
  const int64_t n = (int64_t)cv_param_num(params, "bins", 256);
  if (n < 2 || n > 4096) { last_status = CV_ERR_PARAM; return NULL; }
  int32_t *counts = (int32_t *)calloc((size_t)n, sizeof(int32_t));
  if (counts == NULL) { last_status = CV_ERR_ALLOC; return NULL; }
  CvRenderResult r;
  last_status = cv_histogram(src, &spec, counts, n, &r);
  if (last_status != CV_OK) { free(counts); return NULL; }
  result[0] = r.lo;
  result[1] = r.hi;
  *bins = (int32_t)n;
  return counts;
}

/* One value per channel into `values`; the count, or -1 outside the image. */
CVW_EXPORT(cvw_sample) int32_t cvw_sample(const CvBuffer *src, double x, double y, double *values) {
  int32_t n = 0;
  if (cv_sample(src, (int64_t)x, (int64_t)y, values, &n) != CV_OK) return -1;
  return n;
}

/* ------------------------------------------------------------------ */
/* features -- flat f64 records                                         */
/* ------------------------------------------------------------------ */

#define CVW_SEGMENT_FIELDS 12
#define CVW_ARC_FIELDS 20

CVW_EXPORT(cvw_segment_fields) int32_t cvw_segment_fields(void) { return CVW_SEGMENT_FIELDS; }
CVW_EXPORT(cvw_arc_fields) int32_t cvw_arc_fields(void) { return CVW_ARC_FIELDS; }

/*
 * id, pixels, x0, y0, x1, y1, length, angle, residual, rms, cx, cy -- a
 * malloc'd array of `*count` records the caller frees. NULL with a count of
 * zero is an empty result; NULL with the status set is a failure.
 */
CVW_EXPORT(cvw_fit_segments) double *cvw_fit_segments(const CvBuffer *src, int32_t *count) {
  CvSegmentFit *fits = NULL;
  size_t n = 0;
  *count = 0;
  last_status = cv_fit_segments(src, &fits, &n);
  if (last_status != CV_OK || n == 0) { free(fits); return NULL; }
  double *flat = (double *)malloc(n * CVW_SEGMENT_FIELDS * sizeof(double));
  if (flat == NULL) { free(fits); last_status = CV_ERR_ALLOC; return NULL; }
  for (size_t k = 0; k < n; k++) {
    const CvSegmentFit *f = &fits[k];
    double *r = &flat[k * CVW_SEGMENT_FIELDS];
    r[0] = f->id; r[1] = (double)f->pixels;
    r[2] = f->x0; r[3] = f->y0; r[4] = f->x1; r[5] = f->y1;
    r[6] = f->length; r[7] = f->angle; r[8] = f->residual; r[9] = f->rms;
    r[10] = f->cx; r[11] = f->cy;
  }
  free(fits);
  *count = (int32_t)n;
  return flat;
}

/*
 * id, pixels, cx, cy, r, x0, y0, x1, y1, angle0, angle1, sweep, arcLength,
 * chord, sagitta, residual, rms, lineRms, mx, my.
 */
CVW_EXPORT(cvw_fit_arcs) double *cvw_fit_arcs(const CvBuffer *src, int32_t *count) {
  CvArcFit *fits = NULL;
  size_t n = 0;
  *count = 0;
  last_status = cv_fit_arcs(src, &fits, &n);
  if (last_status != CV_OK || n == 0) { free(fits); return NULL; }
  double *flat = (double *)malloc(n * CVW_ARC_FIELDS * sizeof(double));
  if (flat == NULL) { free(fits); last_status = CV_ERR_ALLOC; return NULL; }
  for (size_t k = 0; k < n; k++) {
    const CvArcFit *f = &fits[k];
    double *r = &flat[k * CVW_ARC_FIELDS];
    r[0] = f->id; r[1] = (double)f->pixels;
    r[2] = f->cx; r[3] = f->cy; r[4] = f->r;
    r[5] = f->x0; r[6] = f->y0; r[7] = f->x1; r[8] = f->y1;
    r[9] = f->angle0; r[10] = f->angle1; r[11] = f->sweep; r[12] = f->arc_length;
    r[13] = f->chord; r[14] = f->sagitta; r[15] = f->residual; r[16] = f->rms;
    r[17] = f->line_rms; r[18] = f->mx; r[19] = f->my;
  }
  free(fits);
  *count = (int32_t)n;
  return flat;
}
