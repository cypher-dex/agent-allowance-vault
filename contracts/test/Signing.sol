// SPDX-License-Identifier: MIT
// EIP-3009 helper adapted from Aevum Starter Kit (MIT, PQA Labs).
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {AllowanceVault} from "../src/AllowanceVault.sol";

/// @dev Builds signatures the same way a wallet or an agent would.
library Signing {
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    struct Auth {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    function signReceive(Vm vm, uint256 pk, bytes32 domainSeparator, Auth memory a)
        internal
        pure
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce)
        );
        return vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
    }

    /// @dev EIP-712 `Spend` signature for AllowanceVault.spendWithSig, packed as r || s || v.
    function signSpend(
        Vm vm,
        uint256 pk,
        AllowanceVault vault,
        address agent,
        address payee,
        uint256 amount,
        bytes32 ref,
        uint256 deadline
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.spendDigest(agent, payee, amount, ref, deadline));
        return abi.encodePacked(r, s, v);
    }
}
