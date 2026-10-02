// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20
/// @notice Test-only 6-decimal ERC20 used as the guaranteed funding path for the
///         SignalTrace Treasury demo on Arbitrum Sepolia.
/// @dev This contract is DEPLOYMENT-TEST-ONLY. It must never be used on a live network.
///      `Treasury` takes its asset as an `immutable` constructor argument, so the same
///      Treasury bytecode serves a MockERC20 treasury today and a USDG treasury later
///      without any code change.
///
///      6 decimals mirrors USDG / USDC so the demo's amounts are directly comparable.
contract MockERC20 is ERC20 {
    /// @notice Hard cap on the amount a single address may pull from the faucet, ever.
    uint256 public constant FAUCET_LIMIT = 500_000e6;

    mapping(address => uint256) public faucetClaimed;

    address public immutable faucetAuthority;

    error FaucetExceeded(address account, uint256 requested, uint256 remaining);
    error NotFaucetAuthority(address caller);
    error ZeroAddress();

    constructor(address authority) ERC20("Mock USD", "mUSD") {
        if (authority == address(0)) revert ZeroAddress();
        faucetAuthority = authority;
    }

    /// @dev 6 decimals to mirror USDG / USDC. OpenZeppelin's `ERC20` defaults to 18, so this
    ///      must be stated explicitly: `Treasury` snapshots `assetDecimals` from this value and
    ///      the demo UI formats amounts from it, so a silent 18 would render every amount 1e12x
    ///      too large.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint test tokens to any address, bounded by that address's lifetime cap.
    function faucet(uint256 amount) external {
        uint256 claimed = faucetClaimed[msg.sender];
        if (claimed + amount > FAUCET_LIMIT) {
            revert FaucetExceeded(msg.sender, amount, FAUCET_LIMIT - claimed);
        }
        faucetClaimed[msg.sender] = claimed + amount;
        _mint(msg.sender, amount);
    }

    /// @notice Authority may mint without the per-address cap (used to seed the treasury).
    function mint(address to, uint256 amount) external {
        if (msg.sender != faucetAuthority) revert NotFaucetAuthority(msg.sender);
        _mint(to, amount);
    }
}
