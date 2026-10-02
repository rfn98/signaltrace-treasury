// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

/// @notice Milestone D — pre-flight checks, all read-only, nothing broadcast.
/// @dev Every check that can fail is a `require`, so a green run genuinely means the deployment
///      is safe to attempt, and a red run names the exact problem. The private key is read with
///      `vm.envUint` from the gitignored `.env` and is never logged: only the ADDRESS derived
///      from it is printed.
contract Preflight is Script {
    /// @dev Gas is ~0.03 gwei on Arbitrum Sepolia and the two deployments are roughly 14k and
    ///      300k gas, so the whole deployment costs a tiny fraction of this. The bar is set
    ///      generously to absorb a fee spike; it exists to catch a zero-balance account, which
    ///      is the realistic failure.
    uint256 internal constant MIN_REQUIRED_WEI = 0.01 ether;

    function run() external view {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envAddress("OWNER_ADDRESS");
        address agent = vm.envAddress("AGENT_ADDRESS");
        address stranger = vm.envAddress("STRANGER_ADDRESS");

        console2.log("=== 1. chain ===");
        _checkChain();

        console2.log("=== 2. identities ===");
        // The single most important pre-flight check: a key paired with the wrong address would
        // deploy a treasury owned by an account nobody controls, and the OWNER_ROLE would sit
        // with the address rather than the funded key.
        require(deployer == owner, "DEPLOYER_PRIVATE_KEY does not match OWNER_ADDRESS");
        console2.log("key matches OWNER_ADDRESS : true");
        console2.log("deployer/owner            :", deployer);
        console2.log("agent                     :", agent);
        console2.log("stranger                  :", stranger);

        require(agent != owner, "AGENT_ADDRESS must differ from OWNER_ADDRESS");
        require(stranger != owner, "STRANGER_ADDRESS must differ from OWNER_ADDRESS");
        require(agent != stranger, "STRANGER_ADDRESS must differ from AGENT_ADDRESS");
        require(agent != address(0) && stranger != address(0), "zero address");
        console2.log("all three distinct        : true");

        console2.log("=== 3. funding ===");
        _checkFunding(deployer);

        console2.log("=== 4. stale deployment state ===");
        _checkNoStaleDeployment();

        console2.log("=== PREFLIGHT PASSED ===");
    }

    function _checkChain() internal view {
        uint256 expected = vm.envOr("CHAIN_ID", uint256(421614));
        uint256 actual = block.chainid;
        console2.log("expected chain id :", expected);
        console2.log("live chain id     :", actual);
        console2.log("block             :", block.number);
        require(actual == expected, "RPC is not the expected chain");
        require(actual == 421614, "chain id must be Arbitrum Sepolia 421614");
    }

    function _checkFunding(address deployer) internal view {
        uint256 balance = deployer.balance;
        console2.log("deployer balance (wei)   :", balance);
        console2.log("deployer balance (ether) :", balance / 1 ether);
        require(balance >= MIN_REQUIRED_WEI, "insufficient native ETH for deployment");
    }

    /// @dev Guards against a half-finished earlier run: if the addresses were already populated
    ///      then a previous deployment exists, and re-running would create a second, conflicting
    ///      treasury. Fails loudly instead of silently deploying twice.
    function _checkNoStaleDeployment() internal view {
        address token = vm.envOr("TOKEN_ADDRESS", address(0));
        address treasury = vm.envOr("TREASURY_ADDRESS", address(0));
        console2.log("TOKEN_ADDRESS recorded    :", token);
        console2.log("TREASURY_ADDRESS recorded :", treasury);
        require(token == address(0) && treasury == address(0), "deployment addresses already recorded");
        console2.log("no previous deployment    : true");
    }
}
