/*
 * addon_buffer.c — the JavaScript surface of CvBuffer.
 *
 * The C layer owns the memory (design-lab-model.md §8); JavaScript holds an
 * opaque handle and reaches the pixels through explicit copies. See the
 * bufferRead/bufferWrite section below for why aliasing is not on offer.
 */

#include "addon_buffer.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "buffer.h"

#define THROW_RETURN(env, msg)             \
  do {                                     \
    napi_throw_error((env), NULL, (msg));  \
    return NULL;                           \
  } while (0)

/* ------------------------------------------------------------------ */
/* handle lifetime                                                     */
/* ------------------------------------------------------------------ */

static void finalize_buffer(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  CvBuffer *buffer = (CvBuffer *)data;
  if (buffer == NULL) return;
  cv_buffer_free(buffer); /* safe if already freed: it zeroes the struct */
  free(buffer);
}

napi_status cv_wrap_buffer(napi_env env, napi_value handle, CvBuffer *buffer) {
  return napi_wrap(env, handle, buffer, finalize_buffer, NULL, NULL);
}

static CvBuffer *unwrap(napi_env env, napi_value value) {
  CvBuffer *buffer = NULL;
  if (napi_unwrap(env, value, (void **)&buffer) != napi_ok || buffer == NULL) {
    napi_throw_type_error(env, NULL, "expected a buffer handle");
    return NULL;
  }
  return buffer;
}

/* ------------------------------------------------------------------ */
/* small argument helpers                                              */
/* ------------------------------------------------------------------ */

static bool read_string_prop(napi_env env, napi_value obj, const char *name,
                             char *out, size_t out_len, const char *fallback) {
  napi_value value;
  napi_valuetype type;
  if (napi_get_named_property(env, obj, name, &value) != napi_ok) return false;
  if (napi_typeof(env, value, &type) != napi_ok) return false;
  if (type == napi_undefined || type == napi_null) {
    snprintf(out, out_len, "%s", fallback);
    return true;
  }
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, out, out_len, &written) != napi_ok) {
    return false;
  }
  return true;
}

static bool read_int64_prop(napi_env env, napi_value obj, const char *name,
                            int64_t *out, int64_t fallback) {
  napi_value value;
  napi_valuetype type;
  if (napi_get_named_property(env, obj, name, &value) != napi_ok) return false;
  if (napi_typeof(env, value, &type) != napi_ok) return false;
  if (type == napi_undefined || type == napi_null) {
    *out = fallback;
    return true;
  }
  if (type != napi_number) return false;
  return napi_get_value_int64(env, value, out) == napi_ok;
}

static bool parse_dtype(const char *name, CvDtype *out) {
  if (strcmp(name, "f32") == 0) { *out = CV_DTYPE_F32; return true; }
  if (strcmp(name, "i32") == 0) { *out = CV_DTYPE_I32; return true; }
  return false;
}

static bool parse_space(const char *name, CvSpace *out) {
  if (strcmp(name, "none") == 0)   { *out = CV_SPACE_NONE;   return true; }
  if (strcmp(name, "srgb") == 0)   { *out = CV_SPACE_SRGB;   return true; }
  if (strcmp(name, "linear") == 0) { *out = CV_SPACE_LINEAR; return true; }
  return false;
}

/* ------------------------------------------------------------------ */
/* createBuffer({ width, height, channels, dtype, space })             */
/* ------------------------------------------------------------------ */

static napi_value CreateBuffer(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
    THROW_RETURN(env, "could not read arguments");
  }
  if (argc < 1) THROW_RETURN(env, "createBuffer(spec) requires 1 argument");

  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object) {
    napi_throw_type_error(env, NULL, "createBuffer(spec): spec must be an object");
    return NULL;
  }

  int64_t width = 0, height = 0, channels = 1;
  char dtype_name[16], space_name[16];

  if (!read_int64_prop(env, argv[0], "width", &width, -1) ||
      !read_int64_prop(env, argv[0], "height", &height, -1) ||
      !read_int64_prop(env, argv[0], "channels", &channels, 1)) {
    napi_throw_type_error(env, NULL, "width, height and channels must be numbers");
    return NULL;
  }
  if (!read_string_prop(env, argv[0], "dtype", dtype_name, sizeof(dtype_name), "f32") ||
      !read_string_prop(env, argv[0], "space", space_name, sizeof(space_name), "none")) {
    napi_throw_type_error(env, NULL, "dtype and space must be strings");
    return NULL;
  }

  CvDtype dtype;
  CvSpace space;
  if (!parse_dtype(dtype_name, &dtype)) THROW_RETURN(env, "unknown dtype (expected f32 or i32)");
  if (!parse_space(space_name, &space)) THROW_RETURN(env, "unknown space (expected none, srgb or linear)");

  if (channels < INT32_MIN || channels > INT32_MAX) THROW_RETURN(env, "channels out of range");

  CvBuffer *buffer = (CvBuffer *)calloc(1, sizeof(CvBuffer));
  if (buffer == NULL) THROW_RETURN(env, "out of memory");

  CvStatus status = cv_buffer_alloc(buffer, width, height, (int32_t)channels, dtype, space);
  if (status != CV_OK) {
    free(buffer);
    napi_throw_range_error(env, NULL, cv_status_str(status));
    return NULL;
  }

  napi_value handle;
  if (napi_create_object(env, &handle) != napi_ok ||
      napi_wrap(env, handle, buffer, finalize_buffer, NULL, NULL) != napi_ok) {
    cv_buffer_free(buffer);
    free(buffer);
    THROW_RETURN(env, "could not create buffer handle");
  }
  return handle;
}

/* ------------------------------------------------------------------ */
/* bufferInfo(handle)                                                  */
/* ------------------------------------------------------------------ */

static napi_value BufferInfo(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    THROW_RETURN(env, "bufferInfo(handle) requires 1 argument");
  }
  CvBuffer *buffer = unwrap(env, argv[0]);
  if (buffer == NULL) return NULL;

  napi_value out, v;
  if (napi_create_object(env, &out) != napi_ok) THROW_RETURN(env, "alloc failed");

  napi_create_int64(env, buffer->width, &v);
  napi_set_named_property(env, out, "width", v);
  napi_create_int64(env, buffer->height, &v);
  napi_set_named_property(env, out, "height", v);
  napi_create_int32(env, buffer->channels, &v);
  napi_set_named_property(env, out, "channels", v);
  napi_create_string_utf8(env, cv_dtype_name(buffer->dtype), NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, out, "dtype", v);
  napi_create_string_utf8(env, cv_space_name(buffer->space), NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, out, "space", v);
  napi_create_int64(env, (int64_t)buffer->bytes, &v);
  napi_set_named_property(env, out, "bytes", v);
  napi_create_int64(env, (int64_t)cv_buffer_elements(buffer), &v);
  napi_set_named_property(env, out, "elements", v);
  napi_get_boolean(env, buffer->data != NULL, &v);
  napi_set_named_property(env, out, "live", v);

  return out;
}

/* ------------------------------------------------------------------ */
/* bufferRead / bufferWrite -- explicit copies across the C/JS line     */
/*                                                                      */
/* Measured, not assumed: Electron refuses napi_create_external_array-  */
/* buffer with napi_status 22, "External buffers are not allowed" --    */
/* V8 is built with pointer compression, so a backing store must live   */
/* inside V8's memory cage. Plain Node allows it; Electron does not.    */
/*                                                                      */
/* So C keeps ownership of 64-byte aligned memory and JS access is an   */
/* explicit copy. The names say "read" and "write" precisely so that no */
/* caller assumes aliasing. This matches design-lab-model.md §8 anyway: */
/* views are meant to receive display-resolution tiles, not whole       */
/* buffers, so the copies that remain are small.                        */
/* ------------------------------------------------------------------ */

static napi_typedarray_type ta_type_for(CvDtype dtype) {
  return dtype == CV_DTYPE_F32 ? napi_float32_array : napi_int32_array;
}

static napi_value BufferRead(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    THROW_RETURN(env, "bufferRead(handle) requires 1 argument");
  }
  CvBuffer *buffer = unwrap(env, argv[0]);
  if (buffer == NULL) return NULL;
  if (buffer->data == NULL) THROW_RETURN(env, "buffer has been released");

  void *dst = NULL;
  napi_value arraybuffer;
  if (napi_create_arraybuffer(env, buffer->bytes, &dst, &arraybuffer) != napi_ok) {
    THROW_RETURN(env, "could not allocate result buffer");
  }
  memcpy(dst, buffer->data, buffer->bytes);

  const size_t elements = buffer->bytes / cv_dtype_size(buffer->dtype);
  napi_value view;
  if (napi_create_typedarray(env, ta_type_for(buffer->dtype), elements,
                             arraybuffer, 0, &view) != napi_ok) {
    THROW_RETURN(env, "could not create typed array");
  }
  return view;
}

static napi_value BufferWrite(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
    THROW_RETURN(env, "bufferWrite(handle, values) requires 2 arguments");
  }
  CvBuffer *buffer = unwrap(env, argv[0]);
  if (buffer == NULL) return NULL;
  if (buffer->data == NULL) THROW_RETURN(env, "buffer has been released");

  bool is_typedarray = false;
  if (napi_is_typedarray(env, argv[1], &is_typedarray) != napi_ok || !is_typedarray) {
    napi_throw_type_error(env, NULL, "bufferWrite: values must be a typed array");
    return NULL;
  }

  napi_typedarray_type type;
  size_t length = 0;
  void *src = NULL;
  if (napi_get_typedarray_info(env, argv[1], &type, &length, &src, NULL, NULL) != napi_ok) {
    THROW_RETURN(env, "could not read typed array");
  }
  if (type != ta_type_for(buffer->dtype)) {
    napi_throw_type_error(env, NULL,
                          "bufferWrite: typed array kind does not match the buffer dtype");
    return NULL;
  }

  const size_t expected = buffer->bytes / cv_dtype_size(buffer->dtype);
  if (length != expected) {
    napi_throw_range_error(env, NULL,
                           "bufferWrite: length does not match the buffer element count");
    return NULL;
  }
  memcpy(buffer->data, src, buffer->bytes);

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

/* ------------------------------------------------------------------ */
/* bufferFromRGBA8(pixels, width, height, { as })                       */
/*                                                                      */
/* The bridge from Chromium's image decoder into a lab buffer. The      */
/* decoder hands back 8-bit RGBA in sRGB; this converts to the f32      */
/* working format and drops alpha.                                      */
/*                                                                      */
/* Because the source is 8-bit, sRGB -> linear is an EXACT 256-entry    */
/* lookup rather than a per-pixel power function -- no approximation,   */
/* and no transcendental in the inner loop.                             */
/* ------------------------------------------------------------------ */

/*
 * Note the deliberate round through float: the value is narrowed to f32
 * BEFORE the transfer function is applied.
 *
 * Without it, `load(as=linear)` and `toLinear(load(...))` disagree by one f32
 * ULP on about half the byte values -- mathematically the same result reached
 * by two routes, differing because one of them stores an intermediate as f32
 * and the other does not. Numerically that is nothing; for a lab that compares
 * content hashes it is the difference between two provenance chains agreeing
 * and not. Where two routes to the same value exist, make them agree on
 * purpose.
 */
static float srgb_to_linear_byte(int i) {
  const double s = (double)(float)((double)i / 255.0);
  return (float)(s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4));
}

static float linear_to_srgb_byte(int i) {
  const double l = (double)(float)((double)i / 255.0);
  return (float)(l <= 0.0031308 ? 12.92 * l : 1.055 * pow(l, 1.0 / 2.4) - 0.055);
}

static napi_value BufferFromRGBA8(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3) {
    THROW_RETURN(env, "bufferFromRGBA8(pixels, width, height, opts) requires 3 arguments");
  }

  bool is_typedarray = false;
  if (napi_is_typedarray(env, argv[0], &is_typedarray) != napi_ok || !is_typedarray) {
    napi_throw_type_error(env, NULL, "bufferFromRGBA8: pixels must be a typed array");
    return NULL;
  }
  napi_typedarray_type type;
  size_t length = 0;
  void *data = NULL;
  if (napi_get_typedarray_info(env, argv[0], &type, &length, &data, NULL, NULL) != napi_ok) {
    THROW_RETURN(env, "bufferFromRGBA8: could not read pixels");
  }
  if (type != napi_uint8_clamped_array && type != napi_uint8_array) {
    napi_throw_type_error(env, NULL, "bufferFromRGBA8: pixels must be 8-bit");
    return NULL;
  }

  int64_t width = 0, height = 0;
  if (napi_get_value_int64(env, argv[1], &width) != napi_ok ||
      napi_get_value_int64(env, argv[2], &height) != napi_ok) {
    napi_throw_type_error(env, NULL, "bufferFromRGBA8: width and height must be numbers");
    return NULL;
  }

  /* Hostile input (§3): check the geometry against the actual byte count
   * before trusting either. */
  size_t expected = 0;
  if (!cv_mul_checked((size_t)(width > 0 ? width : 0), (size_t)(height > 0 ? height : 0), &expected) ||
      !cv_mul_checked(expected, 4, &expected)) {
    THROW_RETURN(env, "bufferFromRGBA8: dimensions overflow");
  }
  if (expected == 0 || length != expected) {
    napi_throw_range_error(env, NULL,
        "bufferFromRGBA8: pixel length does not match width * height * 4");
    return NULL;
  }

  char as_name[16] = "srgb";
  char from_name[16] = "srgb";
  if (argc >= 4) {
    napi_value value;
    napi_valuetype vt;
    size_t written = 0;
    if (napi_get_named_property(env, argv[3], "as", &value) == napi_ok &&
        napi_typeof(env, value, &vt) == napi_ok && vt == napi_string) {
      napi_get_value_string_utf8(env, value, as_name, sizeof(as_name), &written);
    }
    if (napi_get_named_property(env, argv[3], "from", &value) == napi_ok &&
        napi_typeof(env, value, &vt) == napi_ok && vt == napi_string) {
      napi_get_value_string_utf8(env, value, from_name, sizeof(from_name), &written);
    }
  }
  const bool as_linear = (strcmp(as_name, "linear") == 0);
  const bool from_linear = (strcmp(from_name, "linear") == 0);
  if ((!as_linear && strcmp(as_name, "srgb") != 0) ||
      (!from_linear && strcmp(from_name, "srgb") != 0)) {
    THROW_RETURN(env, "bufferFromRGBA8: `as` and `from` must be \"srgb\" or \"linear\"");
  }

  /*
   * 8-bit input means the whole transfer function is exactly 256 values, so
   * every combination is a lookup rather than a per-pixel power function.
   *
   * `from` says what the stored bytes MEAN; `as` says what the buffer should
   * hold. When they agree there is no curve to apply at all -- linear samples
   * stored as bytes are already linear once divided by 255.
   */
  float lut[256];
  for (int i = 0; i < 256; i++) {
    if (from_linear == as_linear) {
      lut[i] = (float)((double)i / 255.0);
    } else if (as_linear) {
      lut[i] = srgb_to_linear_byte(i);      /* srgb bytes -> linear values */
    } else {
      lut[i] = linear_to_srgb_byte(i);      /* linear bytes -> srgb values */
    }
  }
  const bool to_linear = as_linear;

  CvBuffer *buffer = (CvBuffer *)calloc(1, sizeof(CvBuffer));
  if (buffer == NULL) THROW_RETURN(env, "out of memory");

  const CvStatus status = cv_buffer_alloc(buffer, width, height, 3, CV_DTYPE_F32,
                                          to_linear ? CV_SPACE_LINEAR : CV_SPACE_SRGB);
  if (status != CV_OK) {
    free(buffer);
    napi_throw_range_error(env, NULL, cv_status_str(status));
    return NULL;
  }

  const uint8_t *src = (const uint8_t *)data;
  float *dst = (float *)buffer->data;
  const size_t pixels = (size_t)width * (size_t)height;
  for (size_t i = 0; i < pixels; i++) {
    dst[i * 3 + 0] = lut[src[i * 4 + 0]];
    dst[i * 3 + 1] = lut[src[i * 4 + 1]];
    dst[i * 3 + 2] = lut[src[i * 4 + 2]];
    /* alpha is dropped: the lab has no compositing model yet */
  }

  napi_value handle;
  if (napi_create_object(env, &handle) != napi_ok ||
      cv_wrap_buffer(env, handle, buffer) != napi_ok) {
    cv_buffer_free(buffer);
    free(buffer);
    THROW_RETURN(env, "could not create buffer handle");
  }
  return handle;
}

/* ------------------------------------------------------------------ */
/* bufferRelease(handle) -- explicit free, rather than waiting for GC  */
/* ------------------------------------------------------------------ */

static napi_value BufferRelease(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    THROW_RETURN(env, "bufferRelease(handle) requires 1 argument");
  }
  CvBuffer *buffer = unwrap(env, argv[0]);
  if (buffer == NULL) return NULL;

  cv_buffer_free(buffer); /* idempotent */

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

/* ------------------------------------------------------------------ */

static napi_status export_fn(napi_env env, napi_value exports, const char *name,
                             napi_callback cb) {
  napi_value fn;
  napi_status status =
      napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn);
  if (status != napi_ok) return status;
  return napi_set_named_property(env, exports, name, fn);
}

napi_status cv_register_buffer_api(napi_env env, napi_value exports) {
  napi_status status;
  if ((status = export_fn(env, exports, "createBuffer", CreateBuffer)) != napi_ok) return status;
  if ((status = export_fn(env, exports, "bufferInfo", BufferInfo)) != napi_ok) return status;
  if ((status = export_fn(env, exports, "bufferRead", BufferRead)) != napi_ok) return status;
  if ((status = export_fn(env, exports, "bufferWrite", BufferWrite)) != napi_ok) return status;
  if ((status = export_fn(env, exports, "bufferRelease", BufferRelease)) != napi_ok) return status;
  if ((status = export_fn(env, exports, "bufferFromRGBA8", BufferFromRGBA8)) != napi_ok) return status;
  return napi_ok;
}
