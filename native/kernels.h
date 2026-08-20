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

/** @returns NULL if there is no kernel of that name. */
const CvKernelEntry *cv_kernel_lookup(const char *name);

/** Enumerate for tests and generated documentation. */
size_t cv_kernel_count(void);
const CvKernelEntry *cv_kernel_at(size_t index);

#endif /* CVLAB_KERNELS_H */
