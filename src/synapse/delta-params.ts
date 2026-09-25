import type { DeltaParams } from "./delta.ts";

/**
 * The frozen delta parameters (task card P4-2).
 *
 * Chosen by `experiments/legacy/calibrate-delta.mjs` over 239 recorded (query, base) pairs
 * from G1's reserved rounds — the frozen snapshot at commit 3491b37, recorded in
 * the follow-up register AC-17 names as the controlled condition — and judged by
 * retrieval consistency: the top-5 a receiver ranks from the decoded vector must
 * be the top-5 the true query vector ranks.
 *
 * What the calibration found, in the order it matters:
 *
 * 1. No combination reached full consistency. The best ordered top-5 was 58.2%
 *    (grid 256, threshold 0.99), so what is frozen here is a downgraded point and
 *    the benefit claim stays unproven (spec §8.3's honest exit). Two effects of
 *    the same size cause it, and neither is the codec being written badly. A
 *    residual stopped at cosine 0.99 displaces the query by ~0.1414 in norm,
 *    which shifts any single corpus cosine by about 0.1414/√1024 ≈ 4.4e-3; the
 *    5th and 6th ranks of this corpus sit a median 5.5e-3 apart, the same order
 *    of magnitude. And at grid 127 quantization alone costs ~26 points of the
 *    loss (its zero-residual ceiling is 74.1%), so tightening the threshold could
 *    not recover them either. Full details in §4 of the calibration report.
 * 2. Quantization, not the residual, is what binds the ceiling at the coarse end.
 *    With no residual loss at all, grid 32 keeps the ordered top-5 only 43.9% of
 *    the time; grid 8192 is the first grid at which this sample reaches 100%,
 *    32x the card's upper bound of 256 (where the lossless-fixed ceiling is
 *    88.7%). The card's scan space therefore cannot contain a fully consistent
 *    point, which is a correction to the card's assumption rather than a defect.
 * 3. Above the coarse end the two best points are not resolvable from each other
 *    at this sample size. At threshold 0.99, grid 256 leads grid 127 by 1.26
 *    points on 27 pairs against 24 (exact two-sided sign test p = 0.78); on the
 *    progression recording it is 35 against 26 (p = 0.31). Pooled, 62 against 50
 *    (p = 0.30), with a 95% interval on the difference of [-1.82, +6.84] points —
 *    which bounds grid 256's advantage without establishing equivalence. The
 *    frozen point is the cheaper of the two, and the report says exactly this
 *    rather than claiming the two are the same.
 *
 * The cheaper point also keeps the format the codec already implements. Int8
 * components with a two-byte index (stride 3) cap a payload at 3072 bytes —
 * strictly below the 4096-byte float32 vector it replaces, so the sender's
 * rate-distortion check can never fail on size — whereas the int16 layout can
 * reach exactly 4096 bytes and save nothing. Measured payloads here average 1790
 * bytes with a worst case of 2106.
 *
 * Retrieval at this point on the reserved follow-up rounds: top-1 identity 97.9%,
 * top-5 as a set 79.1%, ordered top-5 56.9%.
 */
export const SYNAPSE_DELTA_PARAMS: DeltaParams = { grid: 127, threshold: 0.99 };

/**
 * The component layout the frozen point was measured in. `delta.ts` implements
 * exactly this one; a wider grid would need a wider value field, and the
 * calibration says the extra bytes buy nothing.
 */
export const SYNAPSE_DELTA_LAYOUT = "int8";

/** The calibration this file was frozen from: `experiments/legacy/records/<id>.md` and its `.json` twin. */
/**
 * The expanded calibration (991 rounds / 990 pairs, same corpus and provider) is
 * in experiments/legacy/records/delta-calibration-20260919-expanded.md. It did not move this
 * point: the paired difference against the literal pick stayed at +1.41pp with a
 * 95% CI of [-1.66, +4.49]pp, and resolving it would need about 4680 pairs while
 * the memory store's own record cap allows roughly 995 — so the difference is
 * permanently below this setup's resolution floor rather than merely unmeasured.
 */
export const SYNAPSE_DELTA_CALIBRATION_ID = "delta-calibration-20260919";
