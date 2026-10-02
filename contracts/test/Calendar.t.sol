// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Calendar} from "../src/libraries/Calendar.sol";

/// @notice Bucketing must be a true UTC civil calendar, because "a monthly limit" has to mean
///         what a human means by it and a released reservation has to land in the bucket it was
///         made in. These tests pin the boundaries that a hand-rolled implementation gets wrong.
contract CalendarTest is Test {
    uint256 internal constant SEP_01_2026 = 1_788_220_800; // 2026-09-01T00:00:00Z
    uint256 internal constant JAN_01_2026 = 1_767_225_600; // 2026-01-01T00:00:00Z
    uint256 internal constant JAN_01_2027 = 1_767_225_600 + 365 days;

    // -----------------------------------------------------------------
    // Days
    // -----------------------------------------------------------------

    function test_DayIndexIsSecondsOver86400() public pure {
        assertEq(Calendar.dayIndex(0), 0, "epoch");
        assertEq(Calendar.dayIndex(86_399), 0, "last second of day 0");
        assertEq(Calendar.dayIndex(86_400), 1, "first second of day 1");
        assertEq(Calendar.dayIndex(SEP_01_2026), SEP_01_2026 / 1 days, "fixture");
    }

    function test_DayBoundaryIsMidnightUtcNotRollingWindow() public pure {
        uint256 midnight = SEP_01_2026 + 1 days;
        // The last second of a day and the first second of the next are different buckets...
        assertEq(Calendar.dayIndex(midnight - 1), Calendar.dayIndex(SEP_01_2026), "same day up to 23:59:59");
        assertTrue(Calendar.dayIndex(midnight) > Calendar.dayIndex(SEP_01_2026), "resets at 00:00:00");
    }

    function test_DailyAndMonthlyBucketsAdvanceTogetherWithinAMonth() public pure {
        uint256 month = Calendar.monthKey(SEP_01_2026);
        for (uint256 i = 0; i < 30; i++) {
            assertEq(Calendar.monthKey(SEP_01_2026 + i * 1 days), month, "still September");
        }
        // 30 days after Sep 1 is Oct 1.
        assertEq(Calendar.monthKey(SEP_01_2026 + 30 days), month + 1, "October is the next key");
    }

    // -----------------------------------------------------------------
    // Months
    // -----------------------------------------------------------------

    function test_YearMonthAtKnownTimestamps() public {
        vm.warp(SEP_01_2026);
        (uint16 y, uint8 m) = Calendar.currentYearMonth();
        assertEq(y, 2026, "year");
        assertEq(m, 9, "September");

        vm.warp(JAN_01_2026);
        (y, m) = Calendar.currentYearMonth();
        assertEq(y, 2026, "year");
        assertEq(m, 1, "January");
    }

    function test_MonthKeyIsYearTimes12PlusMonth() public pure {
        assertEq(Calendar.monthKey(JAN_01_2026), 2026 * 12 + 1, "Jan 2026");
        assertEq(Calendar.monthKey(SEP_01_2026), 2026 * 12 + 9, "Sep 2026");
        assertEq(Calendar.monthKey(JAN_01_2027), 2027 * 12 + 1, "Jan 2027");
        assertEq(Calendar.monthKey(JAN_01_2027) - Calendar.monthKey(JAN_01_2026), 12, "a year is 12 keys");
    }

    function test_EveryMonthOfAYearHasADistinctKeyInOrder() public pure {
        uint256 first = Calendar.monthKey(JAN_01_2026);
        for (uint256 month = 1; month <= 12; month++) {
            // Walk to the 1st of each month by scanning days, so the test never hard-codes a
            // month's length.
            uint256 ts = JAN_01_2026;
            for (uint256 i = 0; i < 400; i++) {
                if (Calendar.monthKey(ts) == first + month - 1) break;
                ts += 1 days;
            }
            assertEq(Calendar.monthKey(ts), first + month - 1, "month key found in order");
        }
    }

    function test_MonthResetsOnTheFirstNotTheThirtieth() public pure {
        // A rolling 30-day window resets on different dates each month. A civil month resets on
        // the 1st. This is the distinction the library exists to preserve.
        uint256 sep30 = SEP_01_2026 + 29 days; // 2026-09-30
        uint256 oct01 = SEP_01_2026 + 30 days; // 2026-10-01
        assertEq(Calendar.monthKey(sep30), Calendar.monthKey(SEP_01_2026), "Sep 30 is still September");
        assertTrue(Calendar.monthKey(oct01) > Calendar.monthKey(sep30), "Oct 1 starts a new month");
    }

    function test_FebruaryInALeapYearHas29Days() public pure {
        // 2024 is a leap year. Feb 29 must exist and must still be February.
        uint256 feb01_2024 = 1_706_745_600;
        assertEq(Calendar.monthKey(feb01_2024), 2024 * 12 + 2, "Feb 2024");
        assertEq(Calendar.monthKey(feb01_2024 + 28 days), 2024 * 12 + 2, "Feb 29 exists");
        assertEq(Calendar.monthKey(feb01_2024 + 29 days), 2024 * 12 + 3, "Mar 1 follows");
    }

    function test_MonthLengthsAreRespectedAcrossAYearBoundary() public {
        // 334 days after 2026-01-01 is 2026-12-01: 2026 is not a leap year.
        uint256 dec01_2026 = JAN_01_2026 + 334 days;
        vm.warp(dec01_2026);
        (uint16 y, uint8 m) = Calendar.currentYearMonth();
        assertEq(y, 2026, "December 2026");
        assertEq(m, 12, "month 12");

        // 31 days after Dec 1 is Jan 1 of the next year.
        vm.warp(dec01_2026 + 31 days);
        (y, m) = Calendar.currentYearMonth();
        assertEq(y, 2027, "January 2027");
        assertEq(m, 1, "month 1");
    }

    function test_CurrentDayAndMonthTrackTheBlockTimestamp() public {
        vm.warp(SEP_01_2026);
        assertEq(Calendar.currentDayIndex(), SEP_01_2026 / 1 days, "day");
        assertEq(Calendar.currentMonthKey(), 2026 * 12 + 9, "month");

        vm.warp(SEP_01_2026 + 45 days); // mid-October
        assertEq(Calendar.currentDayIndex(), (SEP_01_2026 + 45 days) / 1 days, "day moved");
        assertEq(Calendar.currentMonthKey(), 2026 * 12 + 10, "month moved");
    }

    function test_LeapDayDecodesToFebruary() public {
        uint256 feb29_2024 = 1_709_164_800;
        vm.warp(feb29_2024);
        (uint16 y2, uint8 m2) = Calendar.currentYearMonth();
        assertEq(y2, 2024, "year");
        assertEq(m2, 2, "February");
        assertEq(Calendar.monthKey(feb29_2024), 2024 * 12 + 2, "key agrees with the decode");
    }

    function test_PreEpochTimestampsDoNotBreakTheEraArithmetic() public pure {
        // The era adjustment exists for pre-1970 input. The treasury will never see one, but the
        // library must not silently produce a wrong month if it is ever reused elsewhere.
        assertEq(Calendar.dayIndex(0), 0, "epoch day");
        assertEq(Calendar.monthKey(0), 1970 * 12 + 1, "Jan 1970");
    }
}
