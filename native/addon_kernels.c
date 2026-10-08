/*
 * addon_kernels.c — runKernel(name, inputs, params).
 *
 * One entry point for every operation. Because the kernels share a signature
 * (kernels.h), this file contains no per-operation code at all: adding a
 * kernel means one table row in kernels.c and one registry entry in JS.
 */

#include "addon_kernels.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "addon_buffer.h"
#include "buffer.h"
#include "fits.h"
#include "kernels.h"
#include "render.h"

#define THROW_RETURN(env, msg)            \
  do {                                    \
    napi_throw_error((env), NULL, (msg)); \
    return NULL;                          \
  } while (0)

/* Build CvParams from a plain JS object. Generic: the kernel reads what it
 * needs by name, so no per-op marshalling exists anywhere. */
static bool read_params(napi_env env, napi_value object, CvParams *out) {
  out->count = 0;

  napi_valuetype type;
  if (napi_typeof(env, object, &type) != napi_ok) return false;
  if (type == napi_undefined || type == napi_null) return true;
  if (type != napi_object) {
    napi_throw_type_error(env, NULL, "params must be an object");
    return false;
  }

  napi_value names;
  uint32_t length = 0;
  if (napi_get_property_names(env, object, &names) != napi_ok) return false;
  if (napi_get_array_length(env, names, &length) != napi_ok) return false;

  for (uint32_t i = 0; i < length; i++) {
    if (out->count >= CV_PARAMS_MAX) {
      napi_throw_range_error(env, NULL, "too many parameters");
      return false;
    }
    napi_value key, value;
    if (napi_get_element(env, names, i, &key) != napi_ok) return false;
    if (napi_get_property(env, object, key, &value) != napi_ok) return false;

    CvParam *param = &out->items[out->count];
    size_t written = 0;
    if (napi_get_value_string_utf8(env, key, param->name, sizeof(param->name),
                                   &written) != napi_ok) {
      return false;
    }

    napi_valuetype value_type;
    if (napi_typeof(env, value, &value_type) != napi_ok) return false;
    switch (value_type) {
      case napi_number:
        param->kind = CV_PARAM_NUMBER;
        if (napi_get_value_double(env, value, &param->number) != napi_ok) return false;
        break;
      case napi_boolean:
        param->kind = CV_PARAM_BOOL;
        if (napi_get_value_bool(env, value, &param->boolean) != napi_ok) return false;
        break;
      case napi_string:
        param->kind = CV_PARAM_STRING;
        if (napi_get_value_string_utf8(env, value, param->string,
                                       sizeof(param->string), &written) != napi_ok) {
          return false;
        }
        break;
      default:
        continue; /* ignore anything a kernel cannot consume */
    }
    out->count++;
  }
  return true;
}

static napi_value scalars_to_js(napi_env env, const CvScalars *scalars) {
  napi_value out, v;
  if (napi_create_object(env, &out) != napi_ok) return NULL;
  napi_create_double(env, scalars->min, &v);    napi_set_named_property(env, out, "min", v);
  napi_create_double(env, scalars->max, &v);    napi_set_named_property(env, out, "max", v);
  napi_create_double(env, scalars->mean, &v);   napi_set_named_property(env, out, "mean", v);
  napi_create_double(env, scalars->stddev, &v); napi_set_named_property(env, out, "stddev", v);
  napi_create_int64(env, scalars->count, &v);   napi_set_named_property(env, out, "count", v);
  return out;
}

static napi_value RunKernel(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
    THROW_RETURN(env, "runKernel(name, inputs, params) requires at least 2 arguments");
  }

  char name[64];
  size_t written = 0;
  if (napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &written) != napi_ok) {
    napi_throw_type_error(env, NULL, "runKernel: name must be a string");
    return NULL;
  }

  const CvKernelEntry *entry = cv_kernel_lookup(name);
  if (entry == NULL) {
    char msg[128];
    snprintf(msg, sizeof(msg), "no kernel named \"%s\"", name);
    THROW_RETURN(env, msg);
  }

  bool is_array = false;
  uint32_t n_inputs = 0;
  if (napi_is_array(env, argv[1], &is_array) != napi_ok || !is_array) {
    napi_throw_type_error(env, NULL, "runKernel: inputs must be an array");
    return NULL;
  }
  if (napi_get_array_length(env, argv[1], &n_inputs) != napi_ok) return NULL;
  if (n_inputs != entry->inputs) {
    char msg[128];
    snprintf(msg, sizeof(msg), "kernel \"%s\" takes %zu input(s), got %u",
             name, entry->inputs, n_inputs);
    napi_throw_range_error(env, NULL, msg);
    return NULL;
  }

  const CvBuffer *inputs[8];
  if (n_inputs > 8) THROW_RETURN(env, "too many inputs");
  for (uint32_t i = 0; i < n_inputs; i++) {
    napi_value handle;
    if (napi_get_element(env, argv[1], i, &handle) != napi_ok) return NULL;
    CvBuffer *buffer = NULL;
    if (napi_unwrap(env, handle, (void **)&buffer) != napi_ok || buffer == NULL) {
      napi_throw_type_error(env, NULL, "runKernel: inputs must be buffer handles");
      return NULL;
    }
    if (buffer->data == NULL) THROW_RETURN(env, "runKernel: an input buffer has been released");
    inputs[i] = buffer;
  }

  CvParams params;
  if (argc >= 3) {
    if (!read_params(env, argv[2], &params)) return NULL;
  } else {
    params.count = 0;
  }

  /* Cancellation is wired through from the first kernel, even though nothing
   * sets the flag yet: adding the parameter later would mean editing every
   * kernel and every call site (§3). */
  volatile int cancel = 0;
  CvKernelCtx ctx = { .cancel = &cancel, .roi = { 0, 0, 0, 0 } };

  CvBuffer produced;
  memset(&produced, 0, sizeof(produced));
  CvScalars scalars;
  memset(&scalars, 0, sizeof(scalars));

  const CvStatus status = entry->fn(inputs, n_inputs, &params, &produced, &scalars, &ctx);
  if (status != CV_OK) {
    napi_throw_error(env, NULL, cv_status_str(status));
    return NULL;
  }

  if (!entry->produces_buffer) return scalars_to_js(env, &scalars);

  CvBuffer *heap = (CvBuffer *)calloc(1, sizeof(CvBuffer));
  if (heap == NULL) { cv_buffer_free(&produced); THROW_RETURN(env, "out of memory"); }
  *heap = produced;

  napi_value handle;
  if (napi_create_object(env, &handle) != napi_ok ||
      cv_wrap_buffer(env, handle, heap) != napi_ok) {
    cv_buffer_free(heap);
    free(heap);
    THROW_RETURN(env, "could not wrap the produced buffer");
  }
  return handle;
}

/* ------------------------------------------------------------------ */
/* the display path                                                     */
/*                                                                      */
/* §8: downsampling happens in C so only display-resolution RGBA crosses */
/* into JavaScript. A 12 MP slot in an 800x600 tile is 1.9 MB out, not   */
/* 48 MB -- which matters doubly here, since Electron forbids external   */
/* ArrayBuffers and every crossing is a real copy.                       */
/* ------------------------------------------------------------------ */

static CvBuffer *handle_arg(napi_env env, napi_value value) {
  CvBuffer *buffer = NULL;
  if (napi_unwrap(env, value, (void **)&buffer) != napi_ok || buffer == NULL) {
    napi_throw_type_error(env, NULL, "expected a buffer handle");
    return NULL;
  }
  if (buffer->data == NULL) {
    napi_throw_error(env, NULL, "buffer has been released");
    return NULL;
  }
  return buffer;
}

static napi_value RenderTile(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    THROW_RETURN(env, "renderTile(handle, spec) requires a handle");
  }
  CvBuffer *src = handle_arg(env, argv[0]);
  if (src == NULL) return NULL;

  CvParams params;
  params.count = 0;
  if (argc >= 2 && !read_params(env, argv[1], &params)) return NULL;

  CvRenderSpec spec;
  cv_render_spec_from_params(&params, &spec);
  if (spec.width <= 0 || spec.height <= 0 || spec.width > 16384 || spec.height > 16384) {
    THROW_RETURN(env, "renderTile: width and height must be between 1 and 16384");
  }

  size_t bytes = 0;
  if (!cv_mul_checked((size_t)spec.width, (size_t)spec.height, &bytes) ||
      !cv_mul_checked(bytes, 4, &bytes)) {
    THROW_RETURN(env, "renderTile: tile size overflows");
  }

  void *dst = NULL;
  napi_value arraybuffer;
  if (napi_create_arraybuffer(env, bytes, &dst, &arraybuffer) != napi_ok) {
    THROW_RETURN(env, "renderTile: could not allocate the tile");
  }

  CvRenderResult result;
  const CvStatus status = cv_render(src, &spec, (uint8_t *)dst, &result);
  if (status != CV_OK) {
    napi_throw_error(env, NULL, cv_status_str(status));
    return NULL;
  }

  napi_value pixels;
  if (napi_create_typedarray(env, napi_uint8_clamped_array, bytes, arraybuffer, 0,
                             &pixels) != napi_ok) {
    THROW_RETURN(env, "renderTile: could not create the pixel view");
  }

  napi_value out, v;
  napi_create_object(env, &out);
  napi_set_named_property(env, out, "pixels", pixels);
  napi_create_int64(env, result.width, &v);  napi_set_named_property(env, out, "width", v);
  napi_create_int64(env, result.height, &v); napi_set_named_property(env, out, "height", v);
  napi_create_double(env, result.lo, &v);    napi_set_named_property(env, out, "lo", v);
  napi_create_double(env, result.hi, &v);    napi_set_named_property(env, out, "hi", v);
  return out;
}

static napi_value Histogram(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    THROW_RETURN(env, "histogram(handle, spec) requires a handle");
  }
  CvBuffer *src = handle_arg(env, argv[0]);
  if (src == NULL) return NULL;

  CvParams params;
  params.count = 0;
  if (argc >= 2 && !read_params(env, argv[1], &params)) return NULL;

  CvRenderSpec spec;
  cv_render_spec_from_params(&params, &spec);
  const int64_t bins = (int64_t)cv_param_num(&params, "bins", 256);
  if (bins < 2 || bins > 4096) THROW_RETURN(env, "histogram: bins must be between 2 and 4096");

  void *dst = NULL;
  napi_value arraybuffer;
  if (napi_create_arraybuffer(env, (size_t)bins * sizeof(int32_t), &dst,
                              &arraybuffer) != napi_ok) {
    THROW_RETURN(env, "histogram: could not allocate");
  }

  CvRenderResult result;
  const CvStatus status = cv_histogram(src, &spec, (int32_t *)dst, bins, &result);
  if (status != CV_OK) {
    napi_throw_error(env, NULL, cv_status_str(status));
    return NULL;
  }

  napi_value counts, out, v;
  napi_create_typedarray(env, napi_int32_array, (size_t)bins, arraybuffer, 0, &counts);
  napi_create_object(env, &out);
  napi_set_named_property(env, out, "counts", counts);
  napi_create_double(env, result.lo, &v); napi_set_named_property(env, out, "lo", v);
  napi_create_double(env, result.hi, &v); napi_set_named_property(env, out, "hi", v);
  return out;
}

static napi_value SamplePixel(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3) {
    THROW_RETURN(env, "samplePixel(handle, x, y) requires 3 arguments");
  }
  CvBuffer *src = handle_arg(env, argv[0]);
  if (src == NULL) return NULL;

  int64_t x = 0, y = 0;
  napi_get_value_int64(env, argv[1], &x);
  napi_get_value_int64(env, argv[2], &y);

  double values[4];
  int32_t n = 0;
  if (cv_sample(src, x, y, values, &n) != CV_OK) {
    napi_value null_value;
    napi_get_null(env, &null_value);
    return null_value;  /* outside the image is not an error, just nothing */
  }

  napi_value out;
  napi_create_array_with_length(env, (size_t)n, &out);
  for (int32_t i = 0; i < n; i++) {
    napi_value v;
    napi_create_double(env, values[i], &v);
    napi_set_element(env, out, (uint32_t)i, v);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* fitSegments / fitArcs -- geometry out of a label map                 */
/*                                                                      */
/* Computed in fits.c, which the WebAssembly module calls too; what  */
/* is here only hands each record to JavaScript. The field meanings are  */
/* documented there and in native/index.js.                             */
/* ------------------------------------------------------------------ */

static void set_double(napi_env env, napi_value obj, const char *name, double value) {
  napi_value v;
  napi_create_double(env, value, &v);
  napi_set_named_property(env, obj, name, v);
}

static void set_header(napi_env env, napi_value obj, const char *type, int32_t id, int64_t pixels) {
  napi_value v;
  /* Namespaced: `edge-` leaves room for region-, blob- or flow- features
   * later without two unrelated things both calling themselves "segment". */
  napi_create_string_utf8(env, type, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, obj, "type", v);
  napi_create_int32(env, id, &v);      napi_set_named_property(env, obj, "id", v);
  napi_create_int64(env, pixels, &v);  napi_set_named_property(env, obj, "pixels", v);
}

static CvBuffer *label_map_arg(napi_env env, napi_callback_info info, const char *fn) {
  size_t argc = 1;
  napi_value argv[1];
  char msg[96];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    snprintf(msg, sizeof(msg), "%s(handle) requires a buffer handle", fn);
    napi_throw_error(env, NULL, msg);
    return NULL;
  }
  CvBuffer *src = handle_arg(env, argv[0]);
  if (src == NULL) return NULL;
  if (src->dtype != CV_DTYPE_I32 || src->channels != 1) {
    snprintf(msg, sizeof(msg), "%s: %s", fn,
             src->dtype != CV_DTYPE_I32 ? "expects an i32 label map" : "expects 1 channel");
    napi_throw_error(env, NULL, msg);
    return NULL;
  }
  return src;
}

static napi_value FitSegments(napi_env env, napi_callback_info info) {
  CvBuffer *src = label_map_arg(env, info, "fitSegments");
  if (src == NULL) return NULL;

  CvSegmentFit *fits = NULL;
  size_t count = 0;
  const CvStatus status = cv_fit_segments(src, &fits, &count);
  if (status != CV_OK) THROW_RETURN(env, cv_status_str(status));

  napi_value list;
  if (napi_create_array_with_length(env, count, &list) != napi_ok) { free(fits); THROW_RETURN(env, "out of memory"); }
  for (size_t k = 0; k < count; k++) {
    const CvSegmentFit *f = &fits[k];
    napi_value entry;
    napi_create_object(env, &entry);
    set_header(env, entry, "edge-segment", f->id, f->pixels);
    set_double(env, entry, "x0", f->x0);
    set_double(env, entry, "y0", f->y0);
    set_double(env, entry, "x1", f->x1);
    set_double(env, entry, "y1", f->y1);
    set_double(env, entry, "length", f->length);
    set_double(env, entry, "angle", f->angle);
    set_double(env, entry, "residual", f->residual);
    set_double(env, entry, "rms", f->rms);
    set_double(env, entry, "cx", f->cx);
    set_double(env, entry, "cy", f->cy);
    napi_set_element(env, list, (uint32_t)k, entry);
  }
  free(fits);
  return list;
}

static napi_value FitArcs(napi_env env, napi_callback_info info) {
  CvBuffer *src = label_map_arg(env, info, "fitArcs");
  if (src == NULL) return NULL;

  CvArcFit *fits = NULL;
  size_t count = 0;
  const CvStatus status = cv_fit_arcs(src, &fits, &count);
  if (status != CV_OK) THROW_RETURN(env, cv_status_str(status));

  napi_value list;
  if (napi_create_array_with_length(env, count, &list) != napi_ok) { free(fits); THROW_RETURN(env, "out of memory"); }
  for (size_t k = 0; k < count; k++) {
    const CvArcFit *f = &fits[k];
    napi_value entry;
    napi_create_object(env, &entry);
    set_header(env, entry, "edge-arc", f->id, f->pixels);
    set_double(env, entry, "cx", f->cx);
    set_double(env, entry, "cy", f->cy);
    set_double(env, entry, "r", f->r);
    set_double(env, entry, "x0", f->x0);
    set_double(env, entry, "y0", f->y0);
    set_double(env, entry, "x1", f->x1);
    set_double(env, entry, "y1", f->y1);
    set_double(env, entry, "angle0", f->angle0);
    set_double(env, entry, "angle1", f->angle1);
    set_double(env, entry, "sweep", f->sweep);
    set_double(env, entry, "arcLength", f->arc_length);
    set_double(env, entry, "chord", f->chord);
    set_double(env, entry, "sagitta", f->sagitta);
    set_double(env, entry, "residual", f->residual);
    set_double(env, entry, "rms", f->rms);
    set_double(env, entry, "lineRms", f->line_rms);
    set_double(env, entry, "mx", f->mx);
    set_double(env, entry, "my", f->my);
    napi_set_element(env, list, (uint32_t)k, entry);
  }
  free(fits);
  return list;
}

static napi_value KernelNames(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
  if (napi_create_array_with_length(env, cv_kernel_count(), &out) != napi_ok) return NULL;
  for (size_t i = 0; i < cv_kernel_count(); i++) {
    napi_value name;
    napi_create_string_utf8(env, cv_kernel_at(i)->name, NAPI_AUTO_LENGTH, &name);
    napi_set_element(env, out, (uint32_t)i, name);
  }
  return out;
}

napi_status cv_register_kernel_api(napi_env env, napi_value exports) {
  napi_value fn;
  napi_status status;

  status = napi_create_function(env, "runKernel", NAPI_AUTO_LENGTH, RunKernel, NULL, &fn);
  if (status != napi_ok) return status;
  status = napi_set_named_property(env, exports, "runKernel", fn);
  if (status != napi_ok) return status;

  status = napi_create_function(env, "kernelNames", NAPI_AUTO_LENGTH, KernelNames, NULL, &fn);
  if (status != napi_ok) return status;
  status = napi_set_named_property(env, exports, "kernelNames", fn);
  if (status != napi_ok) return status;

  status = napi_create_function(env, "renderTile", NAPI_AUTO_LENGTH, RenderTile, NULL, &fn);
  if (status != napi_ok) return status;
  status = napi_set_named_property(env, exports, "renderTile", fn);
  if (status != napi_ok) return status;

  status = napi_create_function(env, "histogram", NAPI_AUTO_LENGTH, Histogram, NULL, &fn);
  if (status != napi_ok) return status;
  status = napi_set_named_property(env, exports, "histogram", fn);
  if (status != napi_ok) return status;

  status = napi_create_function(env, "samplePixel", NAPI_AUTO_LENGTH, SamplePixel, NULL, &fn);
  if (status != napi_ok) return status;
  status = napi_set_named_property(env, exports, "samplePixel", fn);
  if (status != napi_ok) return status;

  status = napi_create_function(env, "fitSegments", NAPI_AUTO_LENGTH, FitSegments, NULL, &fn);
  if (status != napi_ok) return status;
  status = napi_set_named_property(env, exports, "fitSegments", fn);
  if (status != napi_ok) return status;

  status = napi_create_function(env, "fitArcs", NAPI_AUTO_LENGTH, FitArcs, NULL, &fn);
  if (status != napi_ok) return status;
  return napi_set_named_property(env, exports, "fitArcs", fn);
}
