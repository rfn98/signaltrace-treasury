// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Treasury} from "../src/Treasury.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice Milestone D — deploy MockERC20 + Treasury to Arbitrum Sepolia.
/// @dev SECRET HANDLING. The deployer key is read INSIDE the script with `vm.envUint`, which
///      pulls from the gitignored `.env` that Foundry loads automatically. The key therefore
///      never appears on a command line, so it cannot leak through shell history, a process
///      listing, or a CI log. Do NOT "simplify" this to `forge script --private-key $KEY`.
///      Everything this script logs is a public address or a hash.
///
///      OWNER == DEPLOYER for this deployment, so the policy step runs under the same key. That
///      is an OWNER operation, not an AGENT operation; no agent action is ever performed here.
contract Deploy is Script {
    uint256 internal constant ARBITRUM_SEPOLIA_CHAIN_ID = 421614;

    /// @dev Initial policy, in 6-decimal token units, as decided for Milestone D:
    ///      100 / 500 / 2000 / 25 tokens. All four are real limits, so auto-approval is active
    ///      and payments up to 25 tokens settle without an owner approval step.
    uint256 internal constant POLICY_SINGLE_TX_LIMIT = 100_000_000;
    uint256 internal constant POLICY_DAILY_LIMIT = 500_000_000;
    uint256 internal constant POLICY_MONTHLY_LIMIT = 2_000_000_000;
    uint256 internal constant POLICY_AUTO_APPROVE_LIMIT = 25_000_000;

    function run() external returns (MockERC20 token, Treasury treasury) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envAddress("OWNER_ADDRESS");
        address agent = vm.envAddress("AGENT_ADDRESS");
        address stranger = vm.envAddress("STRANGER_ADDRESS");

        _requireChainId();
        _requireIdentities(deployer, owner, agent, stranger);
        _logIdentities(deployer, owner, agent, stranger);

        // ---- step 1: MockERC20, with the deployer as faucet authority ----
        vm.startBroadcast(deployerKey);
        token = new MockERC20(deployer);
        vm.stopBroadcast();

        console2.log("MockERC20 address  :", address(token));
        console2.log("MockERC20 decimals :", token.decimals());

        // ---- step 2: Treasury, wired to the EXACT token address from step 1 ----
        vm.startBroadcast(deployerKey);
        treasury = new Treasury(IERC20(address(token)), owner, agent);
        vm.stopBroadcast();

        console2.log("Treasury address   :", address(treasury));
        console2.log("Treasury asset     :", address(treasury.asset()));
        // `Treasury` is not `Ownable`, so the owner is identified by its roles, not by an
        // `owner()` getter. The constructor grants DEFAULT_ADMIN_ROLE and OWNER_ROLE to `admin`.
        console2.log("owner has OWNER_ROLE:", treasury.hasRole(treasury.OWNER_ROLE(), owner));
        console2.log("owner has ADMIN    :", treasury.hasRole(treasury.DEFAULT_ADMIN_ROLE(), owner));
        console2.log("agent has AGENT_ROLE:", treasury.hasRole(treasury.AGENT_ROLE(), agent));

        // ---- step 3: OWNER-only policy. No recipient is added: the allowlist starts empty. ----
        Treasury.Policy memory p = Treasury.Policy({
            singleTxLimit: POLICY_SINGLE_TX_LIMIT,
            dailyLimit: POLICY_DAILY_LIMIT,
            monthlyLimit: POLICY_MONTHLY_LIMIT,
            autoApproveLimit: POLICY_AUTO_APPROVE_LIMIT,
            allowUnknownRecipients: false
        });

        vm.startBroadcast(deployerKey);
        treasury.setPolicy(p);
        vm.stopBroadcast();

        console2.log("policy set by owner: yes");
    }

    /// @dev Refuses to deploy anywhere but Arbitrum Sepolia: the one mistake here that is both
    ///      easy to make and impossible to undo.
    function _requireChainId() internal view {
        uint256 expected = vm.envOr("CHAIN_ID", uint256(ARBITRUM_SEPOLIA_CHAIN_ID));
        require(block.chainid == expected, "unexpected chain id");
        console2.log("chain id           :", block.chainid);
    }

    /// @dev ENFORCES the identity rules, so a mistake in `.env` fails loudly instead of producing
    ///      a treasury whose access control does not mean what the report will claim:
    ///        - OWNER == DEPLOYER, so the owner can finish configuring the deployment,
    ///        - AGENT and STRANGER are each distinct from every other identity,
    ///        - none of them is the zero address.
    ///      The AGENT/STRANGER keypair separation is what makes "stranger has no AGENT_ROLE"
    ///      a meaningful assertion: if STRANGER were the same account as AGENT, that check
    ///      could never distinguish a permission bug from a broken test.
    function _requireIdentities(
        address deployer,
        address owner,
        address agent,
        address stranger
    ) internal pure {
        require(owner == deployer, "OWNER_ADDRESS must be the deployer for this deployment");
        require(agent != owner, "AGENT_ADDRESS must differ from OWNER_ADDRESS");
        require(stranger != owner, "STRANGER_ADDRESS must differ from OWNER_ADDRESS");
        require(agent != stranger, "STRANGER_ADDRESS must differ from AGENT_ADDRESS");
        require(agent != address(0) && stranger != address(0), "zero address");
    }

    function _logIdentities(address deployer, address owner, address agent, address stranger)
        internal
        pure
    {
        console2.log("deployer           :", deployer);
        console2.log("owner              :", owner);
        console2.log("agent              :", agent);
        console2.log("stranger           :", stranger);
    }
}
