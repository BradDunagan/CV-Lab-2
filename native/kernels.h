/*
 * kernels.h — the compute kernels and the uniform signature they share.
 *
 * design-lab-model.md §3: every kernel takes the same shape of arguments, so
 * the table below can hold them all as one function-pointer type and dispatch
 * uniformly. Signatures that drift apart force hand-written glue per op.
 *
 * Nothing here knows about JavaScript. That is the point: kernels are testable
 * and benchmarkable outside Electron.
 */
#ifndef CVLAB_KERNELS_H
#define CVLAB_KERNELS_H

#include <stdbool.h>
#include <stddef.h>

#include "buffer.h"

/* --- parameters ---------------------------------------------------- */

#define CV_PARAM_NAME_MAX 32
#define CV_PARAM_STRING_MAX 64
#define CV_PARAMS_MAX 16

typedef enum { CV_PARAM_NUMBER, CV_PARAM_BOOL, CV_PARAM_STRING } CvParamKind;

typedef struct {
  char name[CV_PARAM_NAME_MAX];
  CvParamKind kind;
  double number;
  bool boolean;
  char string[CV_PARAM_STRING_MAX];
} CvParam;

typedef struct {
  CvParam items[CV_PARAMS_MAX];
  size_t count;
} CvParams;

double cv_param_num(const CvParams *params, const char *name, double fallback);
bool cv_param_bool(const CvParams *params, const char *name, bool fallback);
const char *cv_param_str(const CvParams *params, const char *name, const char *fallback);

/* --- context ------------------------------------------------------- */

typedef struct {
  /*
   * Polled periodically by every kernel, from the first kernel written (§3).
   * NULL means "never cancelled". The UI for cancelling can come later; the
   * parameter cannot, because adding it to twenty kernels afterwards is
   * exactly the retrofit worth avoiding.
   */
  const volatile int *cancel;
  /*
   * Always the whole image for now, but present in the signature so that
   * adding region-of-interest support later is not a signature change.
   */
  CvRect roi;
} CvKernelCtx;

/* --- results ------------------------------------------------------- */

typedef struct {
  double min, max, mean, stddev;
  int64_t count;
} CvScalars;

/* --- the uniform signature ----------------------------------------- */

typedef CvStatus (*CvKernelFn)(const CvBuffer *const *inputs, size_t n_inputs,
                               const CvParams *params, CvBuffer *out,
                               CvScalars *scalars, const CvKernelCtx *ctx);

typedef struct {
  const char *name;
  CvKernelFn fn;
  size_t inputs;
  bool produces_buffer; /* false means it fills `scalars` instead */
} CvKernelEntry;

/* --- orthogonal regression ----------------------------------------- */

/*
 * Running sums for total least squares. Adding a point is O(1) and the line
 * comes back in closed form from the 2x2 covariance, so a fit can be
 * maintained incrementally as a region grows.
 *
 * TLS rather than ordinary least squares because OLS minimises VERTICAL
 * residuals and degenerates as a line approaches vertical; TLS minimises
 * perpendicular distance and is rotation-invariant.
 */
typedef struct { double n, sx, sy, sxx, syy, sxy; } CvTls;

void cv_tls_add(CvTls *t, double x, double y);

/** Unit normal and offset, so nx*x + ny*y + c = 0 is the line. */
void cv_tls_line(const CvTls *t, double *nx, double *ny, double *c);

/** Perpendicular distance from a point to that line, in pixels. */
double cv_tls_distance(double nx, double ny, double c, double x, double y);

/* --- label maps ----------------------------------------------------- */

/*
 * Index a label map once: which pixels belong to which segment.
 *
 * Every consumer of a label map needs "the pixels of segment i". Answering
 * that by scanning the whole image per segment is O(segments * pixels), which
 * is what made `merge` take four minutes on a 768x768 checkerboard and never
 * finish at 1024x1024 -- and what `fit` went on doing for another two commits
 * after `merge` was fixed. Shared rather than written twice, so the third
 * consumer of a label map cannot make the same mistake a third time.
 *
 * Counts, then offsets, then one filling pass -- the usual compressed-row
 * layout. On success *offsets has count+2 entries and *members has one entry
 * per labelled pixel, and segment i owns members[offsets[i] .. offsets[i+1]).
 * Both are malloc'd for the caller to free; on failure neither is written.
 *
 * Labels outside 1..count are ignored rather than trusted: the caller derives
 * `count` by scanning, and a mismatch would otherwise write past the offsets.
 */
CvStatus cv_label_index(const int32_t *labels, size_t n, int32_t count,
                        size_t **offsets, int64_t **members);

/** @returns NULL if there is no kernel of that name. */
const CvKernelEntry *cv_kernel_lookup(const char *name);

/** Enumerate for tests and generated documentation. */
size_t cv_kernel_count(void);
const CvKernelEntry *cv_kernel_at(size_t index);

#endif /* CVLAB_KERNELS_H */
