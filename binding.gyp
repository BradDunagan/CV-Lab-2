{
  "targets": [
    {
      "target_name": "cvlab",
      "sources": [
        "native/addon.c",
        "native/addon_buffer.c",
        "native/buffer.c"
      ],
      "include_dirs": ["native"],

      # Node-API version 8 is a conservative, widely-supported floor.
      # Declaring it is what makes this addon ABI-stable across Node/Electron.
      "defines": ["NAPI_VERSION=8"],

      # No C++ exceptions are used anywhere in this addon.
      "cflags!": ["-fno-exceptions"],

      "cflags_c": ["-std=c11"],

      "xcode_settings": {
        "GCC_C_LANGUAGE_STANDARD": "c11",
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "CLANG_CXX_LIBRARY": "libc++"
      },

      "msvs_settings": {
        "VCCLCompilerTool": {
          # /O2 = maximize speed. node-gyp already does this for Release,
          # stated explicitly so the intent survives config changes.
          "Optimization": 2
        }
      }
    }
  ]
}
