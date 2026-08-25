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

static CvRangeMode parse_range(const char *s) {
  if (strcmp(s, "fixed") == 0) return CV_RANGE_FIXED;
  if (strcmp(s, "percentile") == 0) return CV_RANGE_PERCENTILE;
  if (strcmp(s, "symmetric") == 0) return CV_RANGE_SYMMETRIC;
  return CV_RANGE_AUTO;
}

static CvCurve parse_curve(const char *s) {
  if (strcmp(s, "log") == 0) return CV_CURVE_LOG;
  if (strcmp(s, "abs") == 0) return CV_CURVE_ABS;
  if (strcmp(s, "sqrt") == 0) return CV_CURVE_SQRT;
  return CV_CURVE_LINEAR;
}

static CvColormap parse_map(const char *s) {
  if (strcmp(s, "viridis") == 0) return CV_MAP_VIRIDIS;
  if (strcmp(s, "turbo") == 0) return CV_MAP_TURBO;
  if (strcmp(s, "diverging") == 0) return CV_MAP_DIVERGING;
  if (strcmp(s, "categorical") == 0) return CV_MAP_CATEGORICAL;
  if (strcmp(s, "cyclic") == 0) return CV_MAP_CYCLIC;
  return CV_MAP_GRAY;
}

static void spec_from_params(const CvParams *params, CvRenderSpec *spec) {
  memset(spec, 0, sizeof(*spec));
  spec->width = (int64_t)cv_param_num(params, "width", 256);
  spec->height = (int64_t)cv_param_num(params, "height", 256);
  spec->src.x = (int64_t)cv_param_num(params, "x", 0);
  spec->src.y = (int64_t)cv_param_num(params, "y", 0);
  spec->src.width = (int64_t)cv_param_num(params, "w", 0);
  spec->src.height = (int64_t)cv_param_num(params, "h", 0);
  spec->range = parse_range(cv_param_str(params, "range", "auto"));
  spec->lo = cv_param_num(params, "lo", 0.0);
  spec->hi = cv_param_num(params, "hi", 1.0);
  spec->percentile = cv_param_num(params, "percentile", 2.0);
  spec->curve = parse_curve(cv_param_str(params, "curve", "linear"));
  spec->colormap = parse_map(cv_param_str(params, "colormap", "gray"));
  spec->channel = (int32_t)cv_param_num(params, "channel", -1);
  spec->interpolate = cv_param_bool(params, "interpolate", true);
}

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
  spec_from_params(&params, &spec);
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
  spec_from_params(&params, &spec);
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
/* fitSegments(labels) -- geometry out of a segment label map           */
/*                                                                      */
/* The first operation whose result is not pixels. A label map says      */
/* WHICH edge each pixel belongs to; this says what each edge IS: where  */
/* it starts and ends, which way it runs, and how straight it really is. */
/*                                                                      */
/* Angles are measured from +x, anticlockwise, in IMAGE coordinates --   */
/* where y increases DOWNWARD, so 45 degrees descends to the right on    */
/* screen. Reported in [0, 180), because a line has no direction.        */
/*                                                                      */
/* `residual` is the largest PERPENDICULAR distance from any of the      */
/* segment's pixel centres to its fitted line, in pixels. A maximum      */
/* rather than a mean, so it is a guarantee: no pixel lies further out.  */
/* ------------------------------------------------------------------ */

static napi_value FitSegments(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    THROW_RETURN(env, "fitSegments(handle) requires a buffer handle");
  }
  CvBuffer *src = handle_arg(env, argv[0]);
  if (src == NULL) return NULL;
  if (src->dtype != CV_DTYPE_I32) THROW_RETURN(env, "fitSegments: expects an i32 label map");
  if (src->channels != 1) THROW_RETURN(env, "fitSegments: expects 1 channel");

  const int64_t cols = src->width, rows = src->height;
  const int32_t *in = (const int32_t *)src->data;
  const size_t n = (size_t)rows * (size_t)cols;

  int32_t count = 0;
  for (size_t i = 0; i < n; i++) if (in[i] > count) count = in[i];

  napi_value list;
  if (napi_create_array(env, &list) != napi_ok) THROW_RETURN(env, "out of memory");
  if (count <= 0) return list;

  CvTls *fits = (CvTls *)calloc((size_t)count + 1, sizeof(CvTls));
  if (fits == NULL) THROW_RETURN(env, "out of memory");
  for (size_t i = 0; i < n; i++) {
    const int32_t id = in[i];
    if (id > 0) cv_tls_add(&fits[id], (double)(i % (size_t)cols), (double)(i / (size_t)cols));
  }

  uint32_t emitted = 0;
  for (int32_t id = 1; id <= count; id++) {
    if (fits[id].n < 2.0) continue;

    double nx, ny, c;
    cv_tls_line(&fits[id], &nx, &ny, &c);
    const double tx = -ny, ty = nx;          /* along the line */

    double lo = 1e300, hi = -1e300, worst = 0.0, sum_sq = 0.0;
    double ax = 0, ay = 0, bx = 0, by = 0;
    for (size_t i = 0; i < n; i++) {
      if (in[i] != id) continue;
      const double x = (double)(i % (size_t)cols), y = (double)(i / (size_t)cols);
      const double t = tx * x + ty * y;
      if (t < lo) { lo = t; ax = x; ay = y; }
      if (t > hi) { hi = t; bx = x; by = y; }
      const double d = cv_tls_distance(nx, ny, c, x, y);
      if (d > worst) worst = d;
      sum_sq += d * d;
    }

    /*
     * Endpoints projected ONTO the fitted line rather than reported as the
     * extreme pixels themselves. That is where the sub-pixel accuracy comes
     * from: the line is an average over every pixel in the segment, so it
     * localises better than any single pixel centre can.
     */
    const double da = cv_tls_distance(nx, ny, c, ax, ay);
    const double db = cv_tls_distance(nx, ny, c, bx, by);
    const double sa = (nx * ax + ny * ay + c) >= 0 ? -da : da;
    const double sb = (nx * bx + ny * by + c) >= 0 ? -db : db;
    const double px0 = ax + nx * sa, py0 = ay + ny * sa;
    const double px1 = bx + nx * sb, py1 = by + ny * sb;

    double angle = atan2(-nx, ny) * 180.0 / CV_PI;
    angle = fmod(angle, 180.0);
    if (angle < 0.0) angle += 180.0;

    napi_value entry, v;
    napi_create_object(env, &entry);
    /* Namespaced: `edge-` leaves room for region-, blob- or flow- features
     * later without two unrelated things both calling themselves "segment". */
    napi_create_string_utf8(env, "edge-segment", NAPI_AUTO_LENGTH, &v);
    napi_set_named_property(env, entry, "type", v);
    napi_create_int32(env, id, &v);                    napi_set_named_property(env, entry, "id", v);
    napi_create_int64(env, (int64_t)fits[id].n, &v);   napi_set_named_property(env, entry, "pixels", v);
    napi_create_double(env, px0, &v);                  napi_set_named_property(env, entry, "x0", v);
    napi_create_double(env, py0, &v);                  napi_set_named_property(env, entry, "y0", v);
    napi_create_double(env, px1, &v);                  napi_set_named_property(env, entry, "x1", v);
    napi_create_double(env, py1, &v);                  napi_set_named_property(env, entry, "y1", v);
    napi_create_double(env, hypot(px1 - px0, py1 - py0), &v);
    napi_set_named_property(env, entry, "length", v);
    napi_create_double(env, angle, &v);                napi_set_named_property(env, entry, "angle", v);
    napi_create_double(env, worst, &v);                napi_set_named_property(env, entry, "residual", v);
    /* RMS as well as the maximum: the maximum is a guarantee about the worst
     * pixel, the RMS is what error propagation needs when this line gets
     * extrapolated beyond its own extent. */
    napi_create_double(env, sqrt(sum_sq / fits[id].n), &v);
    napi_set_named_property(env, entry, "rms", v);
    napi_create_double(env, fits[id].sx / fits[id].n, &v);
    napi_set_named_property(env, entry, "cx", v);
    napi_create_double(env, fits[id].sy / fits[id].n, &v);
    napi_set_named_property(env, entry, "cy", v);

    napi_set_element(env, list, emitted++, entry);
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
  return napi_set_named_property(env, exports, "fitSegments", fn);
}
