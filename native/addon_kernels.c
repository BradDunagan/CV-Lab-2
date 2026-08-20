/*
 * addon_kernels.c — runKernel(name, inputs, params).
 *
 * One entry point for every operation. Because the kernels share a signature
 * (kernels.h), this file contains no per-operation code at all: adding a
 * kernel means one table row in kernels.c and one registry entry in JS.
 */

#include "addon_kernels.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "addon_buffer.h"
#include "buffer.h"
#include "kernels.h"

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
  return napi_set_named_property(env, exports, "kernelNames", fn);
}
