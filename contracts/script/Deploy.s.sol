// SPDX-License-Identifier: MIT
// Adapted from Aevum Starter Kit (MIT, PQA Labs).
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {AllowanceVault} from "../src/AllowanceVault.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";

/// @notice Deploys IdentityRegistry, AllowanceVault and ReputationRegistry.
///   - Aevum testnet and `make fork`: uses the real tUSD8.
///   - `make anvil` (chain 31337) only: deploys MockUSD8 first.
///   - Anywhere else it stops, rather than deploy a token anyone can mint.
///   Writes the addresses to deployments/<chainId>.json for the web app and the agent.
contract Deploy is Script {
    address constant AEVUM_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    uint256 constant ANVIL_CHAIN = 31337;

    function run()
        external
        returns (AllowanceVault vault, IdentityRegistry identity, ReputationRegistry reputation, address token)
    {
        vm.startBroadcast();
        if (AEVUM_TUSD8.code.length > 0) {
            token = AEVUM_TUSD8;
        } else {
            require(block.chainid == ANVIL_CHAIN, "tUSD8 not found on this chain. Check the RPC (Aevum testnet is 44005).");
            token = address(new MockUSD8());
        }
        identity = new IdentityRegistry();
        vault = new AllowanceVault(IERC20(token), IERC721(address(identity)));
        reputation = new ReputationRegistry(vault);
        vm.stopBroadcast();

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "deployBlock", block.number);
        vm.serializeAddress(key, "token", token);
        vm.serializeAddress(key, "identity", address(identity));
        vm.serializeAddress(key, "reputation", address(reputation));
        string memory json = vm.serializeAddress(key, "vault", address(vault));
        vm.writeJson(json, string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json"));

        console.log("chainId    ", block.chainid);
        console.log("token      ", token);
        console.log("identity   ", address(identity));
        console.log("vault      ", address(vault));
        console.log("reputation ", address(reputation));
    }
}
