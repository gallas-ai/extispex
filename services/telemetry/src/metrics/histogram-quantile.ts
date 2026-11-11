/**
 * Estimates a quantile from bucket counts as Prometheus's `histogram_quantile` does: it finds the
 * bucket holding the quantile and interpolates linearly inside it. The upper bound `Infinity` is
 * the overflow bucket. A quantile there is reported as the largest finite bound, because nothing
 * says how far above that bound the values lie.
 *
 * Returns null when there are no observations, or no finite bound to report.
 */
export function estimateHistogramQuantile(
  quantile: number,
  countsByUpperBound: Map<number, number>,
): number | null {
  const buckets = [...countsByUpperBound].sort(
    ([firstBound], [secondBound]) => firstBound - secondBound,
  );
  const totalCount = buckets.reduce((total, [_upperBound, count]) => total + count, 0);
  if (totalCount <= 0) return null;
  const targetRank = quantile * totalCount;
  let countBelowBucket = 0;
  let lowerBound: number | null = null;
  for (const [upperBound, bucketCount] of buckets) {
    const countUpToBucket = countBelowBucket + bucketCount;
    if (countUpToBucket >= targetRank && bucketCount > 0) {
      if (upperBound === Infinity) return lowerBound;
      if (lowerBound === null) {
        // The first bucket has no lower bound. Prometheus assumes 0, unless the bucket is below it.
        if (upperBound <= 0) return upperBound;
        lowerBound = 0;
      }
      return lowerBound +
        (upperBound - lowerBound) * (targetRank - countBelowBucket) / bucketCount;
    }
    countBelowBucket = countUpToBucket;
    lowerBound = upperBound;
  }
  return lowerBound === Infinity ? null : lowerBound;
}
