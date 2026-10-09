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
 * @returns {{size: number, camera: object, creaseAngle: number, edges: object[], vertices: object[], skipped: string[], predicted: object}}
 *   the document `parseGroundTruth` reads, in pt-lab's pixel convention
 */
export function predictEdges({ objects, camera: cam, size, creaseAngle, margin }: {
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
}): {
    size: number;
    camera: object;
    creaseAngle: number;
    edges: object[];
    vertices: object[];
    skipped: string[];
    predicted: object;
};
