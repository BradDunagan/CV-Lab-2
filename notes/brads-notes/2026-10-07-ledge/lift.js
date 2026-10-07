'use strict';
/** The moving part's height above contact, mm, for a row of a gap-sweep run. */
function liftOf(sweep, r) {
  if (r.poseMm) return r.poseMm[1];
  const shot = r.shotInfo;
  if (shot?.poseMm) return shot.poseMm[1];
  return (sweep.offsetMm?.[1] ?? 0) + (sweep.axis?.[1] ?? 0) * r.gapMm;
}
module.exports = { liftOf };
