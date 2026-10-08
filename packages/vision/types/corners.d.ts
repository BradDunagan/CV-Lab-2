/**
 * @param {Array} features fitted segments, as `fit` produces them
 * @param {{minAngle?:number, maxReachRatio?:number, cluster?:number}} [opts]
 * @returns {Array} corner candidates, strongest agreement first
 */
export function findCorners(features: any[], opts?: {
    minAngle?: number;
    maxReachRatio?: number;
    cluster?: number;
}): any[];
