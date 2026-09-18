/**
 * How one feature is drawn over a tile — the decision on its own, so it can be
 * tested without a canvas.
 *
 * WHY THIS IS NOT A CONDITIONAL IN THE DRAWING CODE.
 *
 * SlotPane used to ask one question, "is this a corner?", and draw everything
 * else as a red line from x0,y0 to x1,y1. That is right for the two things a
 * pipeline detects and wrong for everything else in a session:
 *
 *   - `gt-edge` has exactly those fields, so ground truth was drawn in the
 *     detections' own colour, indistinguishable from them -- and with no
 *     regard for `visible`, so the hidden far side of a mesh was drawn as if
 *     it had been seen. On the nut that is ~4,100 of 6,672 edges.
 *   - `gt-vertex` and `edge-match` have x,y and no x0, so they became
 *     moveTo(NaN, NaN): computed, drawn, and invisible. The corner-drawing
 *     comment in SlotPane describes that same failure being fixed once before.
 *
 * So the type decides, every type the lab produces is named here, and anything
 * unrecognised is reported rather than drawn as a line by default.
 */

/** Every feature type in the lab, and how a tile should draw it. */
const ROLES = {
  // What a pipeline found.
  'edge-segment': 'segment',
  'edge-corner': 'corner',
  // What is really there.
  'gt-edge': 'truth-edge',
  'gt-vertex': 'truth-vertex',
  /*
   * A verdict about a feature, not a feature: match records carry a midpoint
   * and no extent, so drawing one would be drawing a made-up geometry. The
   * overlay script draws the verdict by COLOURING the detection it refers to,
   * which is the honest version and belongs in a later change.
   */
  'edge-match': 'none',
};

/**
 * How to draw `feature`: 'segment', 'corner', 'truth-edge', 'truth-vertex',
 * 'none' for something with no geometry of its own, or 'unknown' for a type
 * this module has never heard of.
 */
export function overlayRole(feature) {
  return ROLES[feature?.type] ?? 'unknown';
}

/** Is this feature one of the two a pipeline detects? */
export function isDetection(feature) {
  const role = overlayRole(feature);
  return role === 'segment' || role === 'corner';
}

/**
 * Is this truth feature something the camera can actually see?
 *
 * `visible` is a FRACTION on an edge and a flag on a vertex — the distinction
 * that made a cube report "12/12 edges" over a score computed from nine, which
 * is why the threshold is the matcher's own rather than a number typed here.
 * An edge occluded by its own object still shows a percent or two at its ends.
 */
export function isVisibleTruth(feature, minVisible) {
  const role = overlayRole(feature);
  if (role === 'truth-edge') return (feature.visible ?? 0) >= minVisible;
  if (role === 'truth-vertex') return feature.visible === true;
  return false;
}

/**
 * The overlays a tile can draw, in drawing order, with what each one is.
 *
 * The `tip` is shown when the pointer rests on that overlay's checkbox. It
 * says what the marks MEAN rather than what the control does -- "corner
 * hypotheses, crossing segments" is the thing a reader cannot get from the
 * picture, and "turns corners on and off" is the thing they can.
 */
export const OVERLAY_KINDS = [
  {
    role: 'truth-edge',
    label: 'truth edges',
    swatch: 'rgba(255, 255, 255, 0.85)',
    tip: 'White: where the renderer says an edge really is, projected from the '
      + 'scene. Only edges the camera can actually see are drawn -- the same '
      + 'ones the score holds the pipeline responsible for finding.',
  },
  {
    role: 'truth-vertex',
    label: 'truth vertices',
    swatch: '#6eaaff',
    tip: 'Blue circles: where the scene\'s own edges really meet, and what a '
      + 'detected corner is graded against. Hidden vertices are not drawn.',
  },
  {
    role: 'segment',
    label: 'segments',
    swatch: '#ff5c8a',
    tip: 'Red: straight edges the pipeline fitted, with a yellow dot at each '
      + 'sub-pixel endpoint. These are detections -- what was found, which is '
      + 'not the same as what is there.',
  },
  {
    role: 'corner',
    label: 'corners',
    swatch: '#7ee787',
    tip: 'Green crosses: corner hypotheses, where fitted segments meet. A '
      + 'solid cross has two or more segments supporting it; a faint one rests '
      + 'on a single pair and is the likelier invention. The circle is the '
      + 'corner\'s own positional uncertainty, drawn at image scale.',
  },
];

/**
 * How many features of each kind these lists would actually DRAW.
 *
 * Drawn, not held: truth counts exclude what the camera cannot see, so the
 * number beside a checkbox matches the marks on the tile. A kind counting zero
 * is a kind with nothing to show, which is what decides whether a slot offers
 * the checkbox at all.
 */
export function overlayCounts(lists, minVisible) {
  const counts = Object.fromEntries(OVERLAY_KINDS.map((k) => [k.role, 0]));
  for (const list of lists) {
    for (const f of list.features) {
      const role = overlayRole(f);
      if (!(role in counts)) continue;
      if (!isDetection(f) && !isVisibleTruth(f, minVisible)) continue;
      counts[role] += 1;
    }
  }
  return counts;
}

/**
 * Should the tile's own label fill be left undrawn?
 *
 * A label map under `mask` is a field of light grey lines: exactly the shape
 * the fitted segments and the truth edges are also drawn as. Two sets of lines
 * in nearly the same place, one of them 1px grey, is a picture that hides the
 * comparison it exists for -- so when a LINE overlay is on, the fill steps
 * aside and leaves the black behind it.
 *
 * Only for `mask`, and only for lines. The greyscale image in `A` is the thing
 * being detected on and must stay; corners are crosses that sit on top of
 * anything without competing with it.
 */
export function hidesLabelFill(colormap, kinds) {
  return colormap === 'mask' && (!!kinds?.segment || !!kinds?.['truth-edge']);
}
