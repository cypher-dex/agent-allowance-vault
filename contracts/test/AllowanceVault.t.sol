// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {AllowanceVault} from "../src/AllowanceVault.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";

contract AllowanceVaultTest is Test {
    MockUSD8 token;
    IdentityRegistry identity;
    AllowanceVault vault;
    ReputationRegistry reputation;

    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address seller = makeAddr("seller");
    address otherSeller = makeAddr("otherSeller");
    address relayer = makeAddr("relayer");
    uint256 agentId;

    uint128 constant PER_TX = 0.10e6; // 0.10 tUSD8
    uint128 constant DAILY = 0.25e6; // 0.25 tUSD8

    event Spent(
        address indexed payee,
        bytes32 indexed ref,
        address indexed agent,
        address owner,
        uint256 agentId,
        uint256 amount
    );

    function setUp() public {
        vm.warp(1_800_000_000);
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        token = new MockUSD8();
        identity = new IdentityRegistry();
        vault = new AllowanceVault(IERC20(address(token)), IERC721(address(identity)));
        reputation = new ReputationRegistry(vault);

        token.mint(owner, 10e6);
        vm.startPrank(owner);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(5e6);
        agentId = identity.register("ipfs://agent.json");
        vault.grant(agent, agentId, PER_TX, DAILY, uint64(block.timestamp + 7 days), _payees(seller), bytes32(0));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ funds

    function test_deposit_and_withdraw() public {
        assertEq(vault.balanceOf(owner), 5e6);
        assertEq(token.balanceOf(address(vault)), 5e6);
        vm.prank(owner);
        vault.withdraw(2e6);
        assertEq(vault.balanceOf(owner), 3e6);
        assertEq(token.balanceOf(owner), 7e6);
    }

    function test_withdraw_more_than_balance_reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.InsufficientVaultBalance.selector, 6e6, 5e6));
        vault.withdraw(6e6);
    }

    function test_depositWithAuthorization_credits_signer_not_relayer() public {
        Signing.Auth memory a = Signing.Auth({
            from: owner,
            to: address(vault),
            value: 1e6,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: keccak256("deposit-1")
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, ownerKey, token.DOMAIN_SEPARATOR(), a);
        vm.prank(relayer);
        vault.depositWithAuthorization(owner, 1e6, 0, a.validBefore, a.nonce, v, r, s);
        assertEq(vault.balanceOf(owner), 6e6);
        assertEq(vault.balanceOf(relayer), 0);
    }

    // ------------------------------------------------------------ grants

    function test_grant_requires_identity_owner() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.NotIdentityOwner.selector, agentId));
        vault.grant(makeAddr("a2"), agentId, PER_TX, DAILY, uint64(block.timestamp + 1 days), _payees(seller), 0);
    }

    function test_grant_rejects_bad_caps_and_expiry() public {
        vm.startPrank(owner);
        vm.expectRevert(AllowanceVault.BadCaps.selector);
        vault.grant(makeAddr("a2"), agentId, 0, DAILY, uint64(block.timestamp + 1 days), _payees(seller), 0);
        vm.expectRevert(AllowanceVault.BadCaps.selector);
        vault.grant(makeAddr("a2"), agentId, DAILY + 1, DAILY, uint64(block.timestamp + 1 days), _payees(seller), 0);
        vm.expectRevert(AllowanceVault.BadExpiry.selector);
        vault.grant(makeAddr("a2"), agentId, PER_TX, DAILY, uint64(block.timestamp), _payees(seller), 0);
        vm.stopPrank();
    }

    function test_agent_key_cannot_be_taken_by_another_owner() public {
        address other = makeAddr("other");
        vm.startPrank(other);
        uint256 otherId = identity.register("ipfs://other.json");
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.AgentOwnedByOther.selector, agent));
        vault.grant(agent, otherId, PER_TX, DAILY, uint64(block.timestamp + 1 days), _payees(seller), 0);
        vm.stopPrank();
    }

    function test_only_grant_owner_can_revoke_or_change_payees() public {
        vm.startPrank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.NotGrantOwner.selector, agent));
        vault.revoke(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.NotGrantOwner.selector, agent));
        vault.setPayee(agent, otherSeller, true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ spend: happy paths

    function test_spend_pays_payee_and_records_receipt() public {
        bytes32 ref = keccak256("quote-1");
        vm.expectEmit(address(vault));
        emit Spent(seller, ref, agent, owner, agentId, 0.05e6);
        vm.prank(agent);
        vault.spend(seller, 0.05e6, ref);

        assertEq(token.balanceOf(seller), 0.05e6);
        assertEq(vault.balanceOf(owner), 5e6 - 0.05e6);
        AllowanceVault.Receipt memory rc = vault.receiptOf(seller, ref);
        assertEq(rc.agent, agent);
        assertEq(rc.owner, owner);
        assertEq(rc.agentId, agentId);
        assertEq(rc.amount, 0.05e6);
        assertEq(rc.paidAt, block.timestamp);
        assertEq(vault.remainingToday(agent), DAILY - 0.05e6);
    }

    function test_spendWithSig_lets_a_gasless_agent_pay() public {
        bytes32 ref = keccak256("quote-sig");
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = Signing.signSpend(vm, agentKey, vault, agent, seller, 0.05e6, ref, deadline);
        assertEq(agent.balance, 0);
        vm.prank(seller); // the seller submits and pays gas
        vault.spendWithSig(agent, seller, 0.05e6, ref, deadline, sig);
        assertEq(token.balanceOf(seller), 0.05e6);
    }

    function test_same_ref_is_independent_per_payee() public {
        vm.prank(owner);
        vault.setPayee(agent, otherSeller, true);
        bytes32 ref = keccak256("shared");
        vm.startPrank(agent);
        vault.spend(seller, 0.01e6, ref);
        vault.spend(otherSeller, 0.01e6, ref); // a different seller's ref cannot be squatted
        vm.stopPrank();
    }

    // ------------------------------------------------------------ spend: every rejection

    function test_reject_over_per_tx_cap() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.OverPerTxCap.selector, PER_TX + 1, PER_TX));
        vault.spend(seller, PER_TX + 1, keccak256("big"));
    }

    function test_reject_over_daily_cap_then_reset_after_window() public {
        vm.startPrank(agent);
        vault.spend(seller, 0.10e6, keccak256("1"));
        vault.spend(seller, 0.10e6, keccak256("2"));
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.OverDailyCap.selector, 0.10e6, 0.05e6));
        vault.spend(seller, 0.10e6, keccak256("3"));
        vault.spend(seller, 0.05e6, keccak256("4")); // exactly the rest is fine
        assertEq(vault.remainingToday(agent), 0);

        vm.warp(block.timestamp + 1 days);
        assertEq(vault.remainingToday(agent), DAILY);
        vault.spend(seller, 0.10e6, keccak256("5"));
        vm.stopPrank();
    }

    function test_reject_payee_not_allowed() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.PayeeNotAllowed.selector, agent, otherSeller));
        vault.spend(otherSeller, 0.01e6, keccak256("x"));
    }

    function test_reject_after_payee_removed() public {
        vm.prank(owner);
        vault.setPayee(agent, seller, false);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.PayeeNotAllowed.selector, agent, seller));
        vault.spend(seller, 0.01e6, keccak256("x"));
    }

    function test_reject_after_revoke_in_same_block() public {
        vm.prank(owner);
        vault.revoke(agent);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.GrantRevoked.selector, agent));
        vault.spend(seller, 0.01e6, keccak256("x"));
        assertEq(vault.remainingToday(agent), 0);
    }

    function test_reject_after_expiry() public {
        uint64 expiry = vault.grantOf(agent).expiry;
        vm.warp(expiry);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.GrantExpired.selector, agent, expiry));
        vault.spend(seller, 0.01e6, keccak256("x"));
    }

    function test_reject_unknown_agent() public {
        address nobody = makeAddr("nobody");
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.NoGrant.selector, nobody));
        vault.spend(seller, 0.01e6, keccak256("x"));
    }

    function test_reject_replayed_ref() public {
        bytes32 ref = keccak256("once");
        vm.startPrank(agent);
        vault.spend(seller, 0.01e6, ref);
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.RefAlreadyPaid.selector, seller, ref));
        vault.spend(seller, 0.01e6, ref);
        vm.stopPrank();
    }

    function test_reject_replayed_signature() public {
        bytes32 ref = keccak256("sig-once");
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = Signing.signSpend(vm, agentKey, vault, agent, seller, 0.01e6, ref, deadline);
        vault.spendWithSig(agent, seller, 0.01e6, ref, deadline, sig);
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.RefAlreadyPaid.selector, seller, ref));
        vault.spendWithSig(agent, seller, 0.01e6, ref, deadline, sig);
    }

    function test_reject_tampered_signature_fields() public {
        bytes32 ref = keccak256("sig");
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = Signing.signSpend(vm, agentKey, vault, agent, seller, 0.01e6, ref, deadline);
        vm.expectRevert(AllowanceVault.BadSignature.selector);
        vault.spendWithSig(agent, seller, 0.02e6, ref, deadline, sig); // amount changed
        vm.prank(owner);
        vault.setPayee(agent, otherSeller, true);
        vm.expectRevert(AllowanceVault.BadSignature.selector);
        vault.spendWithSig(agent, otherSeller, 0.01e6, ref, deadline, sig); // payee changed
    }

    function test_reject_signature_from_wrong_key() public {
        (, uint256 wrongKey) = makeAddrAndKey("wrong");
        bytes32 ref = keccak256("sig");
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = Signing.signSpend(vm, wrongKey, vault, agent, seller, 0.01e6, ref, deadline);
        vm.expectRevert(AllowanceVault.BadSignature.selector);
        vault.spendWithSig(agent, seller, 0.01e6, ref, deadline, sig);
    }

    function test_reject_expired_signature() public {
        bytes32 ref = keccak256("sig");
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = Signing.signSpend(vm, agentKey, vault, agent, seller, 0.01e6, ref, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.SignatureExpired.selector, deadline));
        vault.spendWithSig(agent, seller, 0.01e6, ref, deadline, sig);
    }

    function test_reject_when_owner_balance_is_short() public {
        vm.prank(owner);
        vault.withdraw(5e6 - 0.02e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceVault.InsufficientVaultBalance.selector, 0.05e6, 0.02e6));
        vault.spend(seller, 0.05e6, keccak256("x"));
        assertEq(vault.remainingToday(agent), 0.02e6);
    }

    function test_regrant_does_not_reset_spent_in_window() public {
        vm.prank(agent);
        vault.spend(seller, 0.10e6, keccak256("1"));
        vm.prank(owner);
        vault.grant(agent, agentId, PER_TX, DAILY, uint64(block.timestamp + 7 days), _payees(seller), 0);
        assertEq(vault.remainingToday(agent), DAILY - 0.10e6);
    }

    function test_regrant_after_revoke_restores_spending() public {
        vm.startPrank(owner);
        vault.revoke(agent);
        vault.grant(agent, agentId, PER_TX, DAILY, uint64(block.timestamp + 7 days), new address[](0), 0);
        vm.stopPrank();
        vm.prank(agent);
        vault.spend(seller, 0.01e6, keccak256("back")); // payee from the first grant is still allowed
    }

    // ------------------------------------------------------------ post-quantum commitment

    function test_pq_key_commitment_and_rotation() public {
        bytes32 k1 = keccak256("ml-dsa-65 pubkey 1");
        bytes32 k2 = keccak256("ml-dsa-65 pubkey 2");
        vm.startPrank(owner);
        vault.grant(agent, agentId, PER_TX, DAILY, uint64(block.timestamp + 7 days), new address[](0), k1);
        assertEq(vault.grantOf(agent).pqKeyHash, k1);
        vault.rotatePqKey(agent, k2);
        assertEq(vault.grantOf(agent).pqKeyHash, k2);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ reputation

    function test_feedback_requires_a_paid_receipt() public {
        bytes32 ref = keccak256("rated");
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.NoReceipt.selector, seller, ref));
        reputation.giveFeedback(ref, 90, "unpaid");

        vm.prank(agent);
        vault.spend(seller, 0.01e6, ref);

        // Someone who was not paid for this ref cannot rate it.
        vm.prank(otherSeller);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.NoReceipt.selector, otherSeller, ref));
        reputation.giveFeedback(ref, 0, "griefing");

        vm.startPrank(seller);
        reputation.giveFeedback(ref, 90, "paid-on-time");
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.AlreadyRated.selector, seller, ref));
        reputation.giveFeedback(ref, 100, "again");
        vm.stopPrank();

        (uint64 count, uint64 avg) = reputation.getSummary(agentId);
        assertEq(count, 1);
        assertEq(avg, 90);
    }

    function test_feedback_score_range() public {
        bytes32 ref = keccak256("r");
        vm.prank(agent);
        vault.spend(seller, 0.01e6, ref);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry.ScoreOutOfRange.selector, 101));
        reputation.giveFeedback(ref, 101, "");
    }

    function test_identity_uri_and_ownership() public {
        assertEq(identity.ownerOf(agentId), owner);
        assertEq(identity.tokenURI(agentId), "ipfs://agent.json");
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry.NotAgentOwner.selector, agentId));
        identity.setAgentURI(agentId, "x");
    }

    // ------------------------------------------------------------ invariant-style fuzz

    /// No sequence of payments inside one window can exceed the daily cap or the per-tx cap.
    function testFuzz_window_spend_never_exceeds_caps(uint96[8] memory amounts) public {
        uint256 total;
        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 amt = bound(amounts[i], 1, 0.2e6);
            vm.prank(agent);
            try vault.spend(seller, amt, keccak256(abi.encode(i))) {
                total += amt;
                assertLe(amt, PER_TX);
            } catch {}
        }
        assertLe(total, DAILY);
        assertEq(token.balanceOf(seller), total);
        assertEq(vault.balanceOf(owner), 5e6 - total);
    }

    function _payees(address p) private pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = p;
    }
}
