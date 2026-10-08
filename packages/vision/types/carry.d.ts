export function carryPlan(rows: any, shots: any, featuresOf: any, opts: any, pooled?: null, ownToo?: boolean, ownRun?: string, ledgeTable?: null): {
    ledges?: ({
        flush: any;
        widthPerMm: any;
        view: any;
        pair: any;
    } | {
        none: boolean;
        view: any;
        pair: any;
    })[] | undefined;
    minPx: any;
    ledgeMax: any;
    sources: any[];
    missing: {
        view: any;
        pair: any;
    }[];
    commands: {};
};
/** The moving part's displacement from contact for a shot, mm: its pose, or the sweep's step. */
export function displacementOf(s: any, opts: any): any;
export function guessFrom(read: any): any;
