/*
 * sha256.h — SHA-256 (FIPS 180-4) over a byte range, in plain C.
 *
 * Every buffer's content hash is this. It lived in JavaScript, through
 * node:crypto, after a copy of the whole buffer across the C/JS line; a
 * browser has no synchronous SHA-256 at all (crypto.subtle is async). Here
 * it runs where the bytes are, in both the addon and the WebAssembly module,
 * and test/sha256.js holds it to node:crypto's answer.
 */
#ifndef CVLAB_SHA256_H
#define CVLAB_SHA256_H

#include <stddef.h>
#include <stdint.h>

/* The 32-byte digest of `bytes` bytes at `data`. */
void cv_sha256(const void *data, size_t bytes, uint8_t digest[32]);

#endif /* CVLAB_SHA256_H */
