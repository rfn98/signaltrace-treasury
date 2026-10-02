/**
 * Exact mirror of `contracts/src/libraries/Calendar.sol`.
 *
 * WHY THIS EXISTS OFF-CHAIN: the contract derives its day/month budget buckets from
 * `block.timestamp`, so an off-chain evaluator can only be faithful if it can derive the
 * same buckets from the same timestamp. The arithmetic below is a line-for-line port of
 * the contract's `civilFromTimestamp` (Howard Hinnant's `civil_from_days`), including the
 * March-shifted epoch so leap days fall at the end of the 400-year cycle.
 *
 * Nothing here reads the wall clock. Callers pass the timestamp they observed.
 */

/** `timestamp / 1 days` — matches the contract's `Calendar.dayIndex`. */
export function dayIndex(timestamp: bigint): bigint {
  return timestamp / 86400n;
}

/** Civil `(year, month)` from a Unix timestamp. Mirrors `civilFromTimestamp`. */
export function civilFromTimestamp(timestamp: bigint): { year: bigint; month: bigint } {
  const z = timestamp / 86400n + 719468n;
  // Solidity truncates toward zero for int256; emulate its floor adjustment exactly.
  const era = z >= 0n ? z / 146097n : (z - 146096n) / 146097n;
  const dayOfEra = z - era * 146097n; // [0, 146096]
  const yearOfEra = (dayOfEra - dayOfEra / 1460n + dayOfEra / 36524n - dayOfEra / 146096n) / 365n;
  const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const mp = (5n * dayOfYear + 2n) / 153n; // [0, 11], March-based index
  const m = mp + (mp < 10n ? 3n : -9n); // [1, 12]
  const y = yearOfEra + era * 400n + (m <= 2n ? 1n : 0n);
  return { year: y, month: m };
}

/** `year * 12 + month` — matches the contract's `Calendar.monthKey`. */
export function monthKey(timestamp: bigint): bigint {
  const { year, month } = civilFromTimestamp(timestamp);
  return year * 12n + month;
}

/**
 * Renders a monthKey back to `YYYY-MM` for evidence display only.
 *
 * INVERSE CAREFULNESS: the contract's key is `year * 12 + month` with a ONE-based month, so
 * December of year Y is `Y*12 + 12`, which naive floor-division would read as "month 0 of
 * Y+1". Month 0 never occurs in the contract's key space, so the December case has to be
 * pulled back explicitly — otherwise every December would be displayed as the following
 * January with a `00` month.
 */
export function monthKeyToYearMonth(key: bigint): string {
  const rem = key % 12n;
  const year = rem === 0n ? key / 12n - 1n : key / 12n;
  const month = rem === 0n ? 12n : rem;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`;
}
