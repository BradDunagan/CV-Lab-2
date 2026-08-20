/*
 * addon_buffer.c — the JavaScript surface of CvBuffer.
 *
 * The C layer owns the memory (design-lab-model.md §8); JavaScript holds an
 * opaque handle and reaches the pixels through explicit copies. See the
 * bufferRead/bufferWrite section below for why aliasing is not on offer.
 */

#include "addon_buffer.h"

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
  return napi_ok;
}
