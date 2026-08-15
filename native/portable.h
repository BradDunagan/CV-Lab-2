/*
 * portable.h — cross-compiler shims.
 *
 * Your three compilers are clang (macOS), MSVC (Windows) and gcc (Linux).
 * Everything in this header exists because one of them disagrees with the
 * other two. Add to it rather than sprinkling #ifdefs through the kernels.
 */
#ifndef CVLAB_PORTABLE_H
#define CVLAB_PORTABLE_H

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

/* `restrict` is spelled `__restrict` by MSVC. Worth using: it tells the
 * optimizer two pointers can't alias, which matters a lot in pixel loops. */
#if defined(_MSC_VER)
#define CV_RESTRICT __restrict
#else
#define CV_RESTRICT restrict
#endif

#if defined(_MSC_VER)
#define CV_INLINE __inline
#else
#define CV_INLINE inline
#endif

/*
 * Aligned allocation. C11's aligned_alloc() does not exist on MSVC, and
 * MSVC's _aligned_malloc() must be paired with _aligned_free() -- calling
 * plain free() on it corrupts the heap. Always use these two together.
 */
#if defined(_MSC_VER)
#include <malloc.h>
static CV_INLINE void *cv_aligned_alloc(size_t alignment, size_t size) {
  return _aligned_malloc(size, alignment);
}
static CV_INLINE void cv_aligned_free(void *ptr) { _aligned_free(ptr); }
#else
static CV_INLINE void *cv_aligned_alloc(size_t alignment, size_t size) {
  void *ptr = NULL;
  if (posix_memalign(&ptr, alignment, size) != 0) return NULL;
  return ptr;
}
static CV_INLINE void cv_aligned_free(void *ptr) { free(ptr); }
#endif

/*
 * Reminder for when you start writing real kernels:
 *
 *   - `long` is 32-bit on Windows (LLP64) and 64-bit on macOS/Linux (LP64).
 *     Use the stdint.h types and size_t everywhere. This truncates silently
 *     on large images rather than failing to compile.
 *   - MSVC has no variable-length arrays. `float k[n][n];` will not build.
 *   - OpenMP is not available with Apple's stock clang without libomp.
 *   - You develop on arm64/NEON and most users run x86-64/AVX2. Write correct
 *     scalar C first, benchmark on both, then add SIMD behind runtime dispatch.
 */

#endif /* CVLAB_PORTABLE_H */
