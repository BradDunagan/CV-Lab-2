#include "buffer.h"

#include <string.h>

size_t cv_dtype_size(CvDtype dtype) {
  switch (dtype) {
    case CV_DTYPE_F32: return sizeof(float);
    case CV_DTYPE_I32: return sizeof(int32_t);
    default: return 0;
  }
}

const char *cv_dtype_name(CvDtype dtype) {
  switch (dtype) {
    case CV_DTYPE_F32: return "f32";
    case CV_DTYPE_I32: return "i32";
    default: return "?";
  }
}

const char *cv_space_name(CvSpace space) {
  switch (space) {
    case CV_SPACE_NONE: return "none";
    case CV_SPACE_SRGB: return "srgb";
    case CV_SPACE_LINEAR: return "linear";
    default: return "?";
  }
}

const char *cv_status_str(CvStatus status) {
  switch (status) {
    case CV_OK: return "ok";
    case CV_ERR_DIMS: return "width and height must be between 1 and 1048576";
    case CV_ERR_CHANNELS: return "channels must be between 1 and 4";
    case CV_ERR_DTYPE: return "unknown dtype";
    case CV_ERR_OVERFLOW: return "buffer size overflows";
    case CV_ERR_ALLOC: return "allocation failed";
    case CV_ERR_CANCELLED: return "cancelled";
    default: return "unknown error";
  }
}

bool cv_mul_checked(size_t a, size_t b, size_t *out) {
  if (a != 0 && b > SIZE_MAX / a) return false;
  *out = a * b;
  return true;
}

size_t cv_buffer_elements(const CvBuffer *buffer) {
  if (buffer == NULL || buffer->data == NULL) return 0;
  size_t n = (size_t)buffer->width;
  if (!cv_mul_checked(n, (size_t)buffer->height, &n)) return 0;
  if (!cv_mul_checked(n, (size_t)buffer->channels, &n)) return 0;
  return n;
}

CvStatus cv_buffer_alloc(CvBuffer *out, int64_t width, int64_t height,
                         int32_t channels, CvDtype dtype, CvSpace space) {
  if (out == NULL) return CV_ERR_DIMS;

  /*
   * Validate before computing anything with these values. Every check here
   * is load-bearing: see design-lab-model.md §3, "Validating inputs is a
   * security requirement, not tidiness".
   */
  if (width <= 0 || height <= 0 || width > CV_MAX_DIM || height > CV_MAX_DIM) {
    return CV_ERR_DIMS;
  }
  if (channels < 1 || channels > 4) return CV_ERR_CHANNELS;

  const size_t element_size = cv_dtype_size(dtype);
  if (element_size == 0) return CV_ERR_DTYPE;

  /* size_t throughout, and every multiply checked. */
  size_t bytes = (size_t)width;
  if (!cv_mul_checked(bytes, (size_t)height, &bytes)) return CV_ERR_OVERFLOW;
  if (!cv_mul_checked(bytes, (size_t)channels, &bytes)) return CV_ERR_OVERFLOW;
  if (!cv_mul_checked(bytes, element_size, &bytes)) return CV_ERR_OVERFLOW;
  if (bytes == 0 || bytes > CV_MAX_BYTES) return CV_ERR_OVERFLOW;

  /* Round up to the alignment so the tail of the last vector is ours. */
  size_t padded = bytes + (CV_ALIGN - 1);
  if (padded < bytes) return CV_ERR_OVERFLOW;
  padded -= padded % CV_ALIGN;

  void *data = cv_aligned_alloc(CV_ALIGN, padded);
  if (data == NULL) return CV_ERR_ALLOC;
  memset(data, 0, padded);

  out->width = width;
  out->height = height;
  out->channels = channels;
  out->dtype = dtype;
  out->space = space;
  out->data = data;
  out->bytes = bytes;
  return CV_OK;
}

void cv_buffer_free(CvBuffer *buffer) {
  if (buffer == NULL) return;
  if (buffer->data != NULL) cv_aligned_free(buffer->data);
  memset(buffer, 0, sizeof(*buffer));
}
