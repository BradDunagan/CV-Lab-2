/**
 * @param {string | Uint8Array} input a string (hashed as UTF-8) or bytes
 * @returns {string} 64 lowercase hex digits
 */
export function sha256(input: string | Uint8Array): string;
