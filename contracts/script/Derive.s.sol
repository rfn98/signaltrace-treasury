// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

/// @notice Prints the PUBLIC address that corresponds to a locally-stored private key.
/// @dev Why this exists: to confirm an address matches its key WITHOUT ever putting the key on a
///      command line or in a log. `cast wallet address --private-key $KEY` would do the same job
///      but leaks the key into shell history and process listings, so it is deliberately not used
///      anywhere in this project.
///
///      Only addresses are ever printed. Reads keys from the gitignored `.env` via `vm.envUint`.
contract Derive is Script {
    function run() external view {
        console2.log("agent              :", vm.addr(vm.envUint("AGENT_PRIVATE_KEY")));
        console2.log("stranger           :", vm.addr(vm.envUint("STRANGER_PRIVATE_KEY")));
        console2.log("test recipient     :", vm.addr(vm.envUint("TEST_RECIPIENT_PRIVATE_KEY")));
    }
}
