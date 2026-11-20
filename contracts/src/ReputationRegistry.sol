// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AllowanceVault} from "./AllowanceVault.sol";

/// @title ReputationRegistry
/// @notice Feedback on agents in the style of ERC-8004's Reputation Registry, with one difference:
///         feedback is only accepted from a payee that the agent actually paid through the
///         AllowanceVault, once per payment. Every score is backed by an on-chain receipt, so the
///         reputation cannot be farmed with fake reviews.
contract ReputationRegistry {
    struct Summary {
        uint64 count;
        uint64 totalScore;
    }

    AllowanceVault public immutable vault;

    mapping(uint256 agentId => Summary) private _summaries;
    mapping(address payee => mapping(bytes32 ref => bool)) public feedbackGiven;

    event NewFeedback(
        uint256 indexed agentId, address indexed payee, bytes32 indexed ref, uint8 score, string tag
    );

    error NoReceipt(address payee, bytes32 ref);
    error AlreadyRated(address payee, bytes32 ref);
    error ScoreOutOfRange(uint8 score);

    constructor(AllowanceVault vault_) {
        vault = vault_;
    }

    /// @notice Rate the agent that paid you for `ref`. `score` is 0 to 100.
    function giveFeedback(bytes32 ref, uint8 score, string calldata tag) external {
        if (score > 100) revert ScoreOutOfRange(score);
        AllowanceVault.Receipt memory rc = vault.receiptOf(msg.sender, ref);
        if (rc.agent == address(0)) revert NoReceipt(msg.sender, ref);
        if (feedbackGiven[msg.sender][ref]) revert AlreadyRated(msg.sender, ref);
        feedbackGiven[msg.sender][ref] = true;

        Summary storage s = _summaries[rc.agentId];
        s.count += 1;
        s.totalScore += score;
        emit NewFeedback(rc.agentId, msg.sender, ref, score, tag);
    }

    /// @return count Number of ratings. @return average Average score (0 to 100), 0 if unrated.
    function getSummary(uint256 agentId) external view returns (uint64 count, uint64 average) {
        Summary memory s = _summaries[agentId];
        count = s.count;
        average = s.count == 0 ? 0 : s.totalScore / s.count;
    }
}
