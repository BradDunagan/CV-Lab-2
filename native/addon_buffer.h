#ifndef CVLAB_ADDON_BUFFER_H
#define CVLAB_ADDON_BUFFER_H

#include <node_api.h>

/* Attaches the buffer API to `exports`. Called from the module initialiser. */
napi_status cv_register_buffer_api(napi_env env, napi_value exports);

#endif /* CVLAB_ADDON_BUFFER_H */
