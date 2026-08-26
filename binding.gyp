{
  "targets": [
    {
      "target_name": "cvlab",
      "sources": [
        "native/addon.c",
        "native/addon_buffer.c",
        "native/addon_kernels.c",
        "native/buffer.c",
        "native/kernels.c",
        "native/render.c"
      ],
      "include_dirs": ["native"],

      # Node-API version 8 is a conservative, widely-supported floor.
      # Declaring it is what makes this addon ABI-stable across Node/Electron.
      "defines": ["NAPI_VERSION=8"],

      # No C++ exceptions are used anywhere in this addon.
      "cflags!": ["-fno-exceptions"],

      # -ffp-contract=off, per design-lab-model.md §5, determinism rule 3.
      #
      # Without it the compiler fuses `a*b + c` into a single FMA with ONE
      # rounding where the hardware has one, and emits a multiply and an add
      # with TWO roundings where it does not. Every accumulation in
      # kernels.c -- the Gaussian taps, the Sobel weights, the TLS running
      # sums -- is such a site.
      #
      # Not theoretical: `otool -tv` on the arm64 build of kernels.o found
      # 167 fmadd/fmla instructions before this flag went in, against none on
      # baseline x86-64, which has no FMA and gets neither -mfma nor
      # -march=x86-64-v3 from node-gyp. So the same source produced different
      # last bits on the development Mac and on the Windows and Linux
      # runners -- and therefore different content hashes, which is the one
      # thing §5 asks the build not to do.
      #
      # The doc said this was decided and the build never said it. Costs a
      # little speed; buys the cross-platform hash comparison the whole
      # reproducibility story rests on. test/determinism.js is what proves it.
      "cflags_c": ["-std=c11", "-ffp-contract=off"],

      "xcode_settings": {
        "GCC_C_LANGUAGE_STANDARD": "c11",
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "CLANG_CXX_LIBRARY": "libc++",
        "OTHER_CFLAGS": ["-ffp-contract=off"]
      },

      "msvs_settings": {
        "VCCLCompilerTool": {
          # /O2 = maximize speed. node-gyp already does this for Release,
          # stated explicitly so the intent survives config changes.
          "Optimization": 2,

          # /fp:precise is MSVC's default and is stated here for the same
          # reason -- it is the setting under which x64 does not contract.
          # UNVERIFIED from the development machine: there is no MSVC here to
          # disassemble. What actually checks it is test/determinism.js
          # running on the windows-2022 runner and agreeing with this one.
          "FloatingPointModel": 0
        }
      }
    }
  ]
}
