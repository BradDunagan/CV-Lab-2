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
/*
 * C11's aligned_alloc, not POSIX's posix_memalign.
 *
 * posix_memalign is only declared by glibc when _POSIX_C_SOURCE >= 200112L,
 * and building with -std=c11 asks for strict ISO C, which does not set it. So
 * every Linux compile emitted `implicit declaration of function
 * 'posix_memalign'` -- silently, because macOS declares it unconditionally and
 * nothing here was reading Linux compiler output.
 *
 * That is not cosmetic. An implicitly declared function is assumed to return
 * int with unspecified arguments; it happens to work on these ABIs and is
 * undefined behaviour. gcc 14 rejects implicit declarations outright, so this
 * was a build break waiting for a newer runner image.
 *
 * aligned_alloc is ISO C11 and therefore declared under -std=c11 with no
 * feature-test macro anywhere. Its one requirement is that the size be a
 * multiple of the alignment, which is enforced here rather than trusted to
 * callers.
 */
static CV_INLINE void *cv_aligned_alloc(size_t alignment, size_t size) {
  if (alignment == 0) return NULL;
  const size_t remainder = size % alignment;
  const size_t rounded = remainder ? size + (alignment - remainder) : size;
  if (rounded < size) return NULL;              /* rounding overflowed */
  return aligned_alloc(alignment, rounded);
}
static CV_INLINE void cv_aligned_free(void *ptr) { free(ptr); }
#endif

/*
 * M_PI is POSIX, not ISO C. MSVC does not define it unless _USE_MATH_DEFINES
 * is set before <math.h>, so a kernel using it compiles on clang and gcc and
 * fails on Windows -- exactly the split this header exists to absorb.
 */
#define CV_PI 3.14159265358979323846

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
