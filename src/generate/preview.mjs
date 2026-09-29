/**
 * When the Scene Editor's path-traced preview is finished.
 *
 * Its own module, and pure, so the rule can be tested under plain node
 * (test/groundtruth.js) rather than only by watching a GPU. The page imports
 * it; nothing else needs to.
 *
 * pt-lab stops accumulating at the sample cap (setMaxSamples), and when
 * denoising is on it takes a final pass there -- on top of its doubling
 * schedule (4, 8, 16, ...). So finished means:
 *
 *   - the path-traced view, not the raster edit view;
 *   - a cap is set -- 0 is pt-lab's "accumulate forever", which never ends;
 *   - the sample count has reached it;
 *   - and, with denoise on, a pass has COMPLETED at or beyond the cap. A pass
 *     at 8 of 16 is on screen and is not the finished image.
 *
 * A denoiser that cannot run -- no WebGPU, or it failed -- never takes that
 * pass, so there the cap alone is the finish. The status line already says
 * why the image is not denoised.
 */
export function previewFinished({
  editMode, samples, maxSamples, denoise, denoiseState, denoisedAt,
}) {
  if (editMode) return false;
  if (!(maxSamples > 0)) return false;
  if (!(Math.floor(samples) >= maxSamples)) return false;
  if (!denoise) return true;
  if (denoiseState === 'unsupported' || denoiseState === 'error') return true;
  return denoiseState === 'denoised' && denoisedAt >= maxSamples;
}

/** The sample counts the control accepts: whole, positive, and bounded. */
export const SAMPLES_MIN = 1;
export const SAMPLES_MAX = 16384;
export const SAMPLES_DEFAULT = 16;
