/**
 * A pose as a 3x4 row-major matrix: position, rotation in degrees about x,
 * then y, then z (three.js's default Euler order, which pt-lab's
 * `setObjectTransform` uses), then scale.
 *
 * @param {{position?: number[], rotation?: number[], scale?: number[]}} t
 * @returns {number[]} 12 numbers
 */
export function poseMatrix(t: {
    position?: number[];
    rotation?: number[];
    scale?: number[];
}): number[];
/**
 * Predict the edges a scene shows from a camera.
 *
 * @param {object} o
 * @param {{name: string, triangles: ArrayLike<number>, pose?: object, matrix?: number[]}[]} o.objects
 *   each object's triangles, 9 numbers each in its own frame, and where it is:
 *   `pose` ({position, rotation in degrees, scale}) or `matrix` (16 numbers,
 *   column-major, three.js's). Neither: the triangles are already in the world.
 * @param {{position: number[], target: number[], up?: number[], fov: number, near?: number}} o.camera
 *   vertical `fov` in degrees; `near` 0.05 as pt-lab's
 * @param {number} o.size   the image's width and height, in pixels
 * @param {number} [o.creaseAngle=20]  degrees; sharper than this is a crease
 * @param {number} [o.margin=0]  pixels: a sample hidden by less than this --
 *   seen again with its image position moved this far, at its own depth, in
 *   any of eight directions -- counts as visible. For identifying edges from a
 *   belief, which is itself a fraction of a pixel off: an edge the belief
 *   tucks just behind a silhouette may be in plain view
 * @param {boolean} [o.join=false]  one edge for each straight feature line, not
 *   one for each triangle edge along it: a CAD export splits a box's edge into
 *   collinear pieces, and a rounded edge's silhouette runs the length of its
 *   fillet in pieces too. Two kept edges are joined where they are the only two
 *   of one cause and one set of objects at a vertex and leave it in exactly
 *   opposite directions (`JOIN_COS`); a curve's chords, which bend, are not.
 *   And a fillet -- a fold spread over facets each softer than `creaseAngle` --
 *   is one crease where it projects no wider than ROUNDED_PX
 *   (`roundedCreases`): the edge a rounded box shows between two faces
 * @param {string[]} [o.only]  the objects whose edges are wanted; every object
 *   still hides what is behind it. A robot arm's CAD meshes, 120,000
 *   triangles, gave 49,000 edges no gap reading uses, and took a minute a
 *   view; named, only the parts measured are worked out. An edge a named
 *   object shares with an unnamed one is classified from the named one's
 *   faces alone
 * @returns {{size: number, camera: object, creaseAngle: number, edges: object[], vertices: object[], skipped: string[], predicted: object}}
 *   the document `parseGroundTruth` reads, in pt-lab's pixel convention
 */
export function predictEdges({ objects, camera: cam, size, creaseAngle, margin, join, only }: {
    objects: {
        name: string;
        triangles: ArrayLike<number>;
        pose?: object;
        matrix?: number[];
    }[];
    camera: {
        position: number[];
        target: number[];
        up?: number[];
        fov: number;
        near?: number;
    };
    size: number;
    creaseAngle?: number | undefined;
    margin?: number | undefined;
    join?: boolean | undefined;
    only?: string[] | undefined;
}): {
    size: number;
    camera: object;
    creaseAngle: number;
    edges: object[];
    vertices: object[];
    skipped: string[];
    predicted: object;
};
