/*
 * cv-lab-2 native addon
 *
 * A minimal but complete Node-API addon demonstrating the three things a
 * compute-heavy Electron app actually needs from its native layer:
 *
 *   1. Reading pixel memory directly out of a JS typed array (no copy).
 *   2. Running the work on a background thread so the UI never freezes.
 *   3. Returning a Promise, and keeping the JS buffer alive while the
 *      worker thread is using it.
 *
 * Node-API (not NAN / raw V8) is used deliberately: it is ABI-stable, so this
 * binary keeps working across Node and Electron upgrades without a rebuild.
 */

#include <node_api.h>

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#include "portable.h"

/* Bail out of a napi_value-returning function if a N-API call fails. */
#define NAPI_CALL(env, call)                                              \
  do {                                                                    \
    if ((call) != napi_ok) {                                              \
      const napi_extended_error_info *error_info__ = NULL;                \
      napi_get_last_error_info((env), &error_info__);                     \
      bool is_pending__ = false;                                          \
      napi_is_exception_pending((env), &is_pending__);                    \
      if (!is_pending__) {                                                \
        napi_throw_error((env), NULL,                                     \
                         (error_info__ && error_info__->error_message)    \
                             ? error_info__->error_message                \
                             : "N-API call failed");                      \
      }                                                                   \
      return NULL;                                                        \
    }                                                                     \
  } while (0)

/* ------------------------------------------------------------------------ */
/* The kernel. Plain C, no JS types -- keep it that way so it stays testable  */
/* and so you can benchmark it outside of Electron.                           */
/* ------------------------------------------------------------------------ */

static void invert_rgba(uint8_t *CV_RESTRICT data, size_t length) {
  for (size_t i = 0; i + 3 < length; i += 4) {
    data[i + 0] = (uint8_t)(255u - data[i + 0]);
    data[i + 1] = (uint8_t)(255u - data[i + 1]);
    data[i + 2] = (uint8_t)(255u - data[i + 2]);
    /* alpha at i + 3 is left alone */
  }
}

/* ------------------------------------------------------------------------ */
/* Argument handling                                                          */
/* ------------------------------------------------------------------------ */

/*
 * Point `out_data` at the typed array's backing store. This is the real
 * pixel memory the JS side owns -- we are not copying it. That is the whole
 * reason to use a typed array rather than passing an Array or a Buffer of
 * numbers across the boundary.
 */
static bool pixels_from_arg(napi_env env, napi_value value,
                            uint8_t **out_data, size_t *out_length) {
  bool is_typedarray = false;
  if (napi_is_typedarray(env, value, &is_typedarray) != napi_ok ||
      !is_typedarray) {
    napi_throw_type_error(env, NULL,
                          "expected a Uint8ClampedArray of RGBA pixels");
    return false;
  }

  napi_typedarray_type type;
  size_t length = 0;
  void *data = NULL;
  if (napi_get_typedarray_info(env, value, &type, &length, &data, NULL,
                               NULL) != napi_ok) {
    napi_throw_error(env, NULL, "could not read typed array");
    return false;
  }

  if (type != napi_uint8_clamped_array && type != napi_uint8_array) {
    napi_throw_type_error(env, NULL,
                          "expected a Uint8ClampedArray or Uint8Array");
    return false;
  }

  if (length == 0 || length % 4 != 0) {
    napi_throw_range_error(
        env, NULL, "pixel length must be a non-zero multiple of 4 (RGBA)");
    return false;
  }

  *out_data = (uint8_t *)data;
  *out_length = length;
  return true;
}

/* ------------------------------------------------------------------------ */
/* invertSync(pixels) -- blocks the calling thread. Here for comparison only. */
/* ------------------------------------------------------------------------ */

static napi_value InvertSync(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 1) {
    napi_throw_type_error(env, NULL, "invertSync(pixels) requires 1 argument");
    return NULL;
  }

  uint8_t *data = NULL;
  size_t length = 0;
  if (!pixels_from_arg(env, argv[0], &data, &length)) return NULL;

  invert_rgba(data, length);

  napi_value undefined;
  NAPI_CALL(env, napi_get_undefined(env, &undefined));
  return undefined;
}

/* ------------------------------------------------------------------------ */
/* invert(pixels) -> Promise -- runs on libuv's thread pool.                  */
/* ------------------------------------------------------------------------ */

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  /*
   * A strong reference to the typed array. Without this, GC could collect the
   * buffer while the worker thread is still writing into it. Released in the
   * complete callback.
   */
  napi_ref array_ref;
  uint8_t *data;
  size_t length;
} InvertTask;

/*
 * Runs on a background thread. It must not touch `env` or any napi_value --
 * only the plain C data we captured up front. This is where all real work goes.
 */
static void ExecuteInvert(napi_env env, void *data) {
  (void)env;
  InvertTask *task = (InvertTask *)data;
  invert_rgba(task->data, task->length);
}

/* Runs back on the JS thread once ExecuteInvert returns. */
static void CompleteInvert(napi_env env, napi_status status, void *data) {
  InvertTask *task = (InvertTask *)data;

  if (status == napi_ok) {
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    napi_resolve_deferred(env, task->deferred, undefined);
  } else {
    napi_value message, error;
    napi_create_string_utf8(env, "invert() was cancelled or failed",
                            NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &error);
    napi_reject_deferred(env, task->deferred, error);
  }

  napi_delete_reference(env, task->array_ref);
  napi_delete_async_work(env, task->work);
  free(task);
}

static napi_value Invert(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 1) {
    napi_throw_type_error(env, NULL, "invert(pixels) requires 1 argument");
    return NULL;
  }

  uint8_t *data = NULL;
  size_t length = 0;
  if (!pixels_from_arg(env, argv[0], &data, &length)) return NULL;

  InvertTask *task = (InvertTask *)calloc(1, sizeof(InvertTask));
  if (task == NULL) {
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  task->data = data;
  task->length = length;

  napi_value promise;
  if (napi_create_promise(env, &task->deferred, &promise) != napi_ok) {
    free(task);
    napi_throw_error(env, NULL, "could not create promise");
    return NULL;
  }

  /* Keep the pixel buffer alive for the duration of the async work. */
  if (napi_create_reference(env, argv[0], 1, &task->array_ref) != napi_ok) {
    free(task);
    napi_throw_error(env, NULL, "could not reference pixel buffer");
    return NULL;
  }

  napi_value resource_name;
  NAPI_CALL(env, napi_create_string_utf8(env, "cvlab:invert", NAPI_AUTO_LENGTH,
                                         &resource_name));
  NAPI_CALL(env, napi_create_async_work(env, NULL, resource_name,
                                        ExecuteInvert, CompleteInvert, task,
                                        &task->work));
  NAPI_CALL(env, napi_queue_async_work(env, task->work));

  return promise;
}

/* ------------------------------------------------------------------------ */
/* Module registration                                                        */
/* ------------------------------------------------------------------------ */

static napi_status export_fn(napi_env env, napi_value exports, const char *name,
                             napi_callback cb) {
  napi_value fn;
  napi_status status =
      napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn);
  if (status != napi_ok) return status;
  return napi_set_named_property(env, exports, name, fn);
}

NAPI_MODULE_INIT() {
  NAPI_CALL(env, export_fn(env, exports, "invert", Invert));
  NAPI_CALL(env, export_fn(env, exports, "invertSync", InvertSync));
  return exports;
}
