// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Treasury} from "../src/Treasury.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice Milestone D — read-only on-chain verification.
/// @dev Uses NO private key and broadcasts NOTHING. It re-reads state from Arbitrum Sepolia, so
///      the results are independent of what the deploy script claimed it did.
///
///      Split into several small functions, each reading the `.env` values it needs. Holding every
///      address, role id and policy field as a local at once overflows the stack, and enabling
///      `via_ir` to paper over that would change the compiler settings the whole project is
///      verified under — not worth it for a reporting script.
contract Verify is Script {
    function run() external view {
        require(block.chainid == vm.envOr("CHAIN_ID", uint256(421614)), "unexpected chain id");
        console2.log("chain id           :", block.chainid);
        console2.log("block              :", block.number);

        _verifyToken(vm.envAddress("TOKEN_ADDRESS"));
        _verifyIdentity(vm.envAddress("TREASURY_ADDRESS"), vm.envAddress("TOKEN_ADDRESS"));
        _verifyRoles(vm.envAddress("TREASURY_ADDRESS"));
        _verifyPolicy(vm.envAddress("TREASURY_ADDRESS"));
        _verifyFreshState(vm.envAddress("TREASURY_ADDRESS"), vm.envAddress("TOKEN_ADDRESS"));
    }

    function _verifyToken(address tokenAddress) internal view {
        MockERC20 token = MockERC20(tokenAddress);
        console2.log("--- MockERC20 ---");
        console2.log("address            :", tokenAddress);
        console2.log("name               :", token.name());
        console2.log("symbol             :", token.symbol());
        console2.log("decimals           :", token.decimals());
        console2.log("faucetAuthority    :", token.faucetAuthority());
        console2.log("totalSupply        :", token.totalSupply());
    }

    /// @dev `Treasury` is not `Ownable`, so there is no `owner()` getter: the owner is whoever
    ///      holds OWNER_ROLE. Ownership is therefore asserted through the roles, below.
    function _verifyIdentity(address treasuryAddress, address expectedAsset) internal view {
        Treasury treasury = Treasury(treasuryAddress);
        console2.log("--- Treasury ---");
        console2.log("address            :", treasuryAddress);

        // The treasury must be wired to the EXACT token that was deployed, not some other ERC20
        // that merely looks similar. Reverts on mismatch instead of printing a false pass.
        require(address(treasury.asset()) == expectedAsset, "asset mismatch");
        console2.log("asset              :", address(treasury.asset()));
        console2.log("assetMatches       :", true);
        console2.log("assetDecimals()    :", treasury.assetDecimals());
        console2.log("paused             :", treasury.paused());

        // No recipient is added at deploy time, so the agent must NOT be allowlisted yet.
        (bool agentApproved, bytes32 agentCategory, uint64 agentAddedAt) =
            treasury.recipients(vm.envAddress("AGENT_ADDRESS"));
        console2.log("agentApproved      :", agentApproved);
        console2.log("agentCategory      :", vm.toString(agentCategory));
        console2.log("agentAddedAt       :", uint256(agentAddedAt));
    }

    function _verifyRoles(address treasuryAddress) internal view {
        Treasury treasury = Treasury(treasuryAddress);
        address owner = vm.envAddress("OWNER_ADDRESS");
        address agent = vm.envAddress("AGENT_ADDRESS");
        address stranger = vm.envAddress("STRANGER_ADDRESS");

        bytes32 ownerRole = treasury.OWNER_ROLE();
        bytes32 agentRole = treasury.AGENT_ROLE();
        bytes32 adminRole = treasury.DEFAULT_ADMIN_ROLE();
        console2.log("--- roles ---");
        console2.log("OWNER_ROLE         :", vm.toString(ownerRole));

        console2.log("hasRole(OWNER, owner)    :", treasury.hasRole(ownerRole, owner));
        console2.log("hasRole(AGENT, agent)    :", treasury.hasRole(agentRole, agent));
        console2.log("hasRole(ADMIN, owner)    :", treasury.hasRole(adminRole, owner));
        console2.log("hasRole(ADMIN, agent)    :", treasury.hasRole(adminRole, agent));
        console2.log("hasRole(OWNER, agent)    :", treasury.hasRole(ownerRole, agent));
        console2.log("hasRole(AGENT, owner)    :", treasury.hasRole(agentRole, owner));
        console2.log("hasRole(OWNER, stranger) :", treasury.hasRole(ownerRole, stranger));
        console2.log("hasRole(AGENT, stranger) :", treasury.hasRole(agentRole, stranger));
        console2.log("hasRole(ADMIN, stranger) :", treasury.hasRole(adminRole, stranger));

        // The positive expectations, asserted rather than merely printed.
        require(treasury.hasRole(ownerRole, owner), "owner missing OWNER_ROLE");
        require(treasury.hasRole(agentRole, agent), "agent missing AGENT_ROLE");
        require(treasury.hasRole(adminRole, owner), "owner missing DEFAULT_ADMIN_ROLE");

        // STRANGER must hold nothing operational.
        require(!treasury.hasRole(ownerRole, stranger), "stranger holds OWNER_ROLE");
        require(!treasury.hasRole(agentRole, stranger), "stranger holds AGENT_ROLE");
        require(!treasury.hasRole(adminRole, stranger), "stranger holds DEFAULT_ADMIN_ROLE");

        // The owner is not merely an agent, and the agent is not an admin.
        require(!treasury.hasRole(ownerRole, agent), "agent must not hold OWNER_ROLE");
        require(!treasury.hasRole(adminRole, agent), "agent must not hold DEFAULT_ADMIN_ROLE");
        console2.log("roleModelVerified  : true");
    }

    /// @dev `policy` is a public struct, so its auto-generated getter returns the five members
    ///      rather than a `Policy memory`.
    function _verifyPolicy(address treasuryAddress) internal view {
        Treasury treasury = Treasury(treasuryAddress);
        uint256 singleTxLimit;
        uint256 dailyLimit;
        uint256 monthlyLimit;
        uint256 autoApproveLimit;
        bool allowUnknown;
        (singleTxLimit, dailyLimit, monthlyLimit, autoApproveLimit, allowUnknown) = treasury.policy();

        console2.log("--- policy ---");
        console2.log("singleTxLimit      :", singleTxLimit);
        console2.log("dailyLimit         :", dailyLimit);
        console2.log("monthlyLimit       :", monthlyLimit);
        console2.log("autoApproveLimit   :", autoApproveLimit);
        console2.log("allowUnknown       :", allowUnknown);

        require(singleTxLimit == 100_000_000, "singleTxLimit mismatch");
        require(dailyLimit == 500_000_000, "dailyLimit mismatch");
        require(monthlyLimit == 2_000_000_000, "monthlyLimit mismatch");
        require(autoApproveLimit == 25_000_000, "autoApproveLimit mismatch");
        require(!allowUnknown, "allowUnknownRecipients should be false");
        require(!treasury.hasUnboundedAutoApproval(), "auto-approval should be bounded");
        console2.log("policyMatches      : true");
    }

    function _verifyFreshState(address treasuryAddress, address assetAddress) internal view {
        Treasury treasury = Treasury(treasuryAddress);
        (uint256 dayCommitted, uint256 monthCommitted) = treasury.currentUsage();
        console2.log("--- fresh state ---");
        console2.log("dayCommitted       :", dayCommitted);
        console2.log("monthCommitted     :", monthCommitted);
        console2.log("lifetimeReserved   :", treasury.lifetimeReserved());
        console2.log("lifetimeSpent      :", treasury.lifetimeSpent());
        console2.log("paymentCount       :", treasury.paymentCount());
        console2.log("adminCount         :", treasury.adminCount());
        console2.log("treasuryTokenBal   :", IERC20(assetAddress).balanceOf(treasuryAddress));

        require(!treasury.paused(), "treasury must not be paused");
        require(treasury.lifetimeSpent() == 0, "a fresh deployment cannot have spent anything");
        console2.log("freshStateVerified : true");
    }
}
