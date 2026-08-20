#ifndef CVLAB_ADDON_BUFFER_H
#define CVLAB_ADDON_BUFFER_H

#include <node_api.h>

#include "buffer.h"

/* Attaches the buffer API to `exports`. Called from the module initialiser. */
napi_status cv_register_buffer_api(napi_env env, napi_value exports);

/*
 * Attach an already-allocated CvBuffer to a JS object, transferring ownership.
 * Shared with addon_kernels.c so that every buffer handle -- however it was
 * produced -- is freed by exactly one finalizer.
 */
napi_status cv_wrap_buffer(napi_env env, napi_value handle, CvBuffer *buffer);

#endif /* CVLAB_ADDON_BUFFER_H */
