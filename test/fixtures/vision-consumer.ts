// A TypeScript host of @cv-lab/vision, as rr will be one: compiled (not run)
// by test/package.js against packages/vision/types/, so a declaration that
// stops describing the package fails there rather than in rr.
import { loadWasm, createRegistry, Session, sha256 } from '@cv-lab/vision';
import type { Backend, HostOptions, DecodedImage } from '@cv-lab/vision';
import { solvePosition } from '@cv-lab/vision/position';

export async function measure(wasmBytes: Uint8Array, decode: (path: string) => Promise<DecodedImage>): Promise<string> {
  const backend: Backend = await loadWasm(wasmBytes);
  const options: HostOptions = { backend, decodeFile: decode, readTextFile: async () => '' };
  const session = new Session({ registry: createRegistry(options) });
  await session.run('A = load("frame.png", as=linear)\nG = gray(A)');
  const names: string[] = backend.kernelNames();
  const build: string | undefined = backend.build;
  void solvePosition;
  return `${names.length} ${build ?? 'native'} ${sha256('x')}`;
}
