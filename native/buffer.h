/*
 * buffer.h — the buffer type, per design-lab-model.md §1–2.
 *
 * Pure C. No Node-API here, deliberately: kernels operate on CvBuffer and
 * never see a JavaScript type, so they stay testable and portable.
 */
#ifndef CVLAB_BUFFER_H
#define CVLAB_BUFFER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "portable.h"

/* f32 is the working format; i32 is the deliberate exception for label maps. */
typedef enum { CV_DTYPE_F32 = 0, CV_DTYPE_I32 = 1 } CvDtype;

/*
 * Color space travels with the buffer (§2). CV_SPACE_NONE is for data where
 * the notion does not apply -- label maps, masks, gradient magnitudes.
 */
typedef enum {
  CV_SPACE_NONE = 0,
  CV_SPACE_SRGB = 1,
  CV_SPACE_LINEAR = 2
} CvSpace;

typedef enum {
  CV_OK = 0,
  CV_ERR_DIMS,      /* non-positive or implausible dimensions */
  CV_ERR_CHANNELS,  /* channels outside 1..4 */
  CV_ERR_DTYPE,
  CV_ERR_OVERFLOW,  /* size computation overflowed */
  CV_ERR_ALLOC,
  CV_ERR_CANCELLED
} CvStatus;

/* A region of interest, in buffer coordinates. Lives here rather than with
 * the kernels because both the kernels and the display path need it. */
typedef struct { int64_t x, y, width, height; } CvRect;

typedef struct {
  int64_t width;
  int64_t height;
  int32_t channels;
  CvDtype dtype;
  CvSpace space;
  void *data;    /* 64-byte aligned, zero-initialised */
  size_t bytes;
} CvBuffer;

/*
 * Sanity limits. Inputs are treated as hostile (§3): a caller-supplied
 * dimension is checked before it is ever used to size an allocation.
 */
#define CV_MAX_DIM (1 << 20)                    /* 1,048,576 px per side */
#define CV_MAX_BYTES ((size_t)8 << 30)          /* 8 GiB */
#define CV_ALIGN 64                             /* room for future SIMD */

size_t cv_dtype_size(CvDtype dtype);
const char *cv_status_str(CvStatus status);
const char *cv_dtype_name(CvDtype dtype);
const char *cv_space_name(CvSpace space);

/*
 * Multiply with overflow detection. Exposed because kernels need it too:
 * width * height * channels overflows a 32-bit int at moderate image sizes
 * and yields a buffer far smaller than the code then writes into.
 */
bool cv_mul_checked(size_t a, size_t b, size_t *out);

/* Allocates zeroed, aligned memory. *out is untouched on failure. */
CvStatus cv_buffer_alloc(CvBuffer *out, int64_t width, int64_t height,
                         int32_t channels, CvDtype dtype, CvSpace space);

/* Safe on an already-freed or zeroed buffer; leaves it zeroed. */
void cv_buffer_free(CvBuffer *buffer);

/* Element count = width * height * channels. Zero if the buffer is empty. */
size_t cv_buffer_elements(const CvBuffer *buffer);

#endif /* CVLAB_BUFFER_H */
