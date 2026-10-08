/**
 * @param {{jacobian: number[], reference: number, measured: number, weight?: number}[]} observations
 *   `jacobian` in px per mm along each axis; `reference` and `measured` in px;
 *   `weight` multiplies that observation's squared residual (default 1).
 * @param {{prior?: {d: number[], covariance: number[][]}}} [options]
 *   `prior`: what is already known of the displacement -- carried from the
 *   previous frame -- as a mean and a covariance, in the unknowns' own units.
 *   It counts as one more set of observations, of d itself; with it, weights
 *   must be absolute (1 / variance in px^2), or the two cannot be balanced.
 * @returns {{determined: boolean, d: number[]|null, sigma: number[]|null,
 *            covariance: number[][]|null, residualRms: number|null,
 *            observations: number, reason: string|null}}
 */
export function solvePosition(observations: {
    jacobian: number[];
    reference: number;
    measured: number;
    weight?: number;
}[], { prior }?: {
    prior?: {
        d: number[];
        covariance: number[][];
    };
}): {
    determined: boolean;
    d: number[] | null;
    sigma: number[] | null;
    covariance: number[][] | null;
    residualRms: number | null;
    observations: number;
    reason: string | null;
};
/**
 * The same, for readings that bend at zero: `hinge[a]` adds hinge[a] *
 * min(d[a], 0) to an observation's model, a slope that applies on one side
 * only. A ledge does that -- slid back past flush, the still part's face
 * shows beside the moving edge, in the moving part's soft shadow, and moves
 * that edge; slid the other way there is no ledge (design-lab-model.md §5,
 * "A nineteenth").
 *
 * Piecewise linear, so it is solved exactly on a side: first ignoring the
 * hinges (or on the prior's side), then on the side each axis came out on,
 * until no axis changes side. Observations with no hinge give solvePosition's
 * answer unchanged.
 */
export function solveHinged(observations: any, { prior, iterations }?: {
    prior?: null | undefined;
    iterations?: number | undefined;
}): {
    determined: boolean;
    d: number[] | null;
    sigma: number[] | null;
    covariance: number[][] | null;
    residualRms: number | null;
    observations: number;
    reason: string | null;
} | null;
/**
 * The same, for readings whose slopes depend on the lift: `lift[a]` adds
 * lift[a] * d[liftAxis] * d[a] to an observation's model. Seen from above
 * and at an angle, a sideways move opens a gap by an amount that depends on
 * how high the part is, so a Jacobian measured at one lift is wrong at
 * another -- by 0.06 to 0.10 mm in x at 1 mm up, calibrated at 4
 * (design-lab-model.md §5, "A twenty-seventh").
 *
 * Bilinear, so solved by Gauss-Newton: at the current estimate d0 the lift
 * term is replaced by its tangent, q(d0) + grad q(d0) . (d - d0), which for a
 * bilinear q is grad q(d0) . d - q(d0); that is solved as solveHinged solves
 * it, and repeated until the estimate stops moving. The covariance is the
 * last tangent's. Observations with no lift give solveHinged's answer.
 *
 * `liftHinge[a]` adds liftHinge[a] * d[liftAxis] * min(d[a], 0): the hinge's
 * one-sided slope changing with the lift too. The ledge it describes is in
 * the moving part's soft shadow, and how much of it shows, and how dark,
 * depends on the height (the twenty-seventh).
 */
export function solveLifted(observations: any, { prior, liftAxis, iterations }?: {
    prior?: null | undefined;
    liftAxis?: number | undefined;
    iterations?: number | undefined;
}): {
    residualRms: number | null;
    determined?: boolean | undefined;
    d?: number[] | null | undefined;
    sigma?: number[] | null | undefined;
    covariance?: number[][] | null | undefined;
    observations?: number | undefined;
    reason?: string | null | undefined;
} | null;
