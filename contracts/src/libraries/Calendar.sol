// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Calendar
/// @notice Minimal UTC civil-calendar bucketing for treasury spending accounting.
/// @dev This is deliberately the *smallest* correct implementation, not a date library.
///      It exists for exactly one reason: `monthKey` must be a true civil month so that
///      a "monthly limit" means what a human means by it, and so that releasing a
///      reservation lands in the exact bucket the reservation was made in.
///
///      "Rolling 30-day window" (`timestamp / 30 days`) is NOT a calendar month and is
///      explicitly rejected: it drifts against real months and resets on the 30th/31st
///      rather than the 1st.
///
///      Algorithm: Howard Hinnant's `civil_from_days` (public domain), which is exact
///      integer math with no iteration, no lookup tables, and no floating point.
library Calendar {
    /// @notice UTC calendar-day index. Day D spans [D*86400, (D+1)*86400).
    /// @dev Matches the brief's "daily" semantics exactly: resets at 00:00:00 UTC.
    function dayIndex(uint256 timestamp) internal pure returns (uint256) {
        return timestamp / 1 days;
    }

    /// @notice UTC calendar-day index for the current block.
    function currentDayIndex() internal view returns (uint256) {
        return dayIndex(block.timestamp);
    }

    /// @notice UTC civil month as `year * 12 + month`. Resets at 00:00:00 UTC on the 1st.
    /// @dev `timestamp` is expected to be `block.timestamp`-scale (~1.8e9), which is roughly
    ///      10^9x below the `int256` ceiling the era arithmetic operates in.
    function monthKey(uint256 timestamp) internal pure returns (uint256) {
        (uint256 year, uint256 month) = civilFromTimestamp(timestamp);
        return year * 12 + month;
    }

    /// @notice UTC civil month for the current block.
    function currentMonthKey() internal view returns (uint256) {
        return monthKey(block.timestamp);
    }

    /// @notice UTC civil year and month for the current block. Convenience for the off-chain UI.
    function currentYearMonth() internal view returns (uint16 year, uint8 month) {
        (uint256 y, uint256 m) = civilFromTimestamp(block.timestamp);
        // Casting is safe because `civilFromTimestamp` returns a provably positive
        // year (< 10000) and month (<= 12) for any post-1970 timestamp.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (uint16(y), uint8(m));
    }

    /// @dev Days-since-epoch -> (civil year, civil month), per Hinnant's `civil_from_days`.
    ///      Only the month is needed downstream, so day-of-month is discarded.
    ///
    ///      The `divide-before-multiply` lints below are intrinsic to the algorithm — the
    ///      divisions are part of the calendar arithmetic, not a lossy optimisation of a
    ///      cheaper multiply. The casts are bounded: `timestamp` is `block.timestamp`-scale
    ///      (~1.8e9) and both `year` and `month` are provably positive for any post-1970
    ///      input. A pathological `timestamp` reverts loudly under Solidity 0.8 checked
    ///      arithmetic rather than producing a wrong month.
    function civilFromTimestamp(uint256 timestamp) private pure returns (uint256 year, uint256 month) {
        // Shift the epoch from 1970-01-01 to 0000-03-01 so leap days land at the end of the cycle.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 z = int256(timestamp / 1 days) + int256(719468);
        // Emulate floor division (C++ semantics) for the pre-epoch era adjustment.
        int256 era = (z >= 0 ? z : z - int256(146096)) / int256(146097);
        // forge-lint: disable-next-line(divide-before-multiply)
        int256 dayOfEra = z - era * int256(146097); // [0, 146096]
        int256 yearOfEra = (dayOfEra - dayOfEra / int256(1460) + dayOfEra / int256(36524) - dayOfEra / int256(146096))
            / int256(365); // [0, 399]
        // forge-lint: disable-next-line(divide-before-multiply)
        int256 dayOfYear = dayOfEra - (int256(365) * yearOfEra + yearOfEra / int256(4) - yearOfEra / int256(100));
        int256 mp = (int256(5) * dayOfYear + int256(2)) / int256(153); // [0, 11], March-based index
        int256 m = mp + (mp < int256(10) ? int256(3) : int256(-9)); // [1, 12]
        // forge-lint: disable-next-line(divide-before-multiply)
        int256 y = yearOfEra + era * int256(400) + (m <= int256(2) ? int256(1) : int256(0));

        // Both are strictly positive for any post-1970 timestamp.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (uint256(y), uint256(m));
    }
}
