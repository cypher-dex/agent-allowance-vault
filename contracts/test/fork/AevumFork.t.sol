// SPDX-License-Identifier: MIT
// Structure adapted from Aevum Starter Kit (MIT, PQA Labs).
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {AllowanceVault} from "../../src/AllowanceVault.sol";
import {IdentityRegistry} from "../../src/IdentityRegistry.sol";
import {ReputationRegistry} from "../../src/ReputationRegistry.sol";
import {Signing} from "../Signing.sol";

interface ITUSD8 is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function decimals() external view returns (uint8);
}

/// @notice The full flow against the REAL tUSD8 on a local fork of Aevum testnet. No funds needed.
///         Run with: make test-fork
contract AevumForkTest is Test {
    ITUSD8 constant TUSD8 = ITUSD8(0x456569838f1d43009A91ebA4263147Afd7233483);

    function test_realTusd8_shape() public view {
        assertEq(block.chainid, 44005, "run with --fork-url aevum");
        assertEq(TUSD8.decimals(), 6);
    }

    IdentityRegistry identity;
    AllowanceVault vault;
    ReputationRegistry reputation;
    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address seller;
    uint256 agentId;

    function _deployAndFund() private {
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        seller = makeAddr("seller");
        identity = new IdentityRegistry();
        vault = new AllowanceVault(IERC20(address(TUSD8)), IERC721(address(identity)));
        reputation = new ReputationRegistry(vault);
        deal(address(TUSD8), owner, 2e6);

        // Owner funds the vault with one EIP-3009 signature; a relayer submits it.
        Signing.Auth memory a = Signing.Auth({
            from: owner,
            to: address(vault),
            value: 1e6,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: keccak256("fork-deposit")
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, ownerKey, TUSD8.DOMAIN_SEPARATOR(), a);
        vm.prank(makeAddr("relayer"));
        vault.depositWithAuthorization(owner, 1e6, 0, a.validBefore, a.nonce, v, r, s);
        assertEq(vault.balanceOf(owner), 1e6);

        address[] memory payees = new address[](1);
        payees[0] = seller;
        vm.startPrank(owner);
        agentId = identity.register("https://example.com/agent.json");
        vault.grant(agent, agentId, 0.1e6, 0.25e6, uint64(block.timestamp + 1 days), payees, bytes32(0));
        vm.stopPrank();
    }

    function test_realTusd8_gaslessDeposit_signedSpend_feedback() public {
        _deployAndFund();

        // Agent signs, seller settles.
        bytes32 ref = keccak256("fork-quote");
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = Signing.signSpend(vm, agentKey, vault, agent, seller, 0.05e6, ref, deadline);
        vm.prank(seller);
        vault.spendWithSig(agent, seller, 0.05e6, ref, deadline, sig);
        assertEq(TUSD8.balanceOf(seller), 0.05e6);

        vm.prank(seller);
        reputation.giveFeedback(ref, 100, "paid");
        (uint64 count, uint64 avg) = reputation.getSummary(agentId);
        assertEq(count, 1);
        assertEq(avg, 100);
    }
}
