// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title IdentityRegistry
/// @notice Minimal on-chain agent identity in the style of ERC-8004's Identity Registry: each agent
///         is an ERC-721 token whose `tokenURI` points at the agent's registration file (name,
///         description, endpoints). The token owner controls the agent's identity.
/// @dev Aevum has no ERC-8004 deployment yet (checked 2026-11-16), so this app ships its own.
///      When QDay publishes official registries, the vault can point at them instead.
contract IdentityRegistry is ERC721 {
    uint256 public totalAgents;
    mapping(uint256 agentId => string) private _agentURIs;

    event Registered(uint256 indexed agentId, address indexed owner, string agentURI);
    event AgentURIUpdated(uint256 indexed agentId, string agentURI);

    error NotAgentOwner(uint256 agentId);

    constructor() ERC721("Aevum Agent Identity", "AGENT") {}

    /// @notice Register a new agent. Agent ids start at 1, so 0 always means "no agent".
    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = ++totalAgents;
        _agentURIs[agentId] = agentURI;
        _safeMint(msg.sender, agentId);
        emit Registered(agentId, msg.sender, agentURI);
    }

    function setAgentURI(uint256 agentId, string calldata agentURI) external {
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId);
        _agentURIs[agentId] = agentURI;
        emit AgentURIUpdated(agentId, agentURI);
    }

    function tokenURI(uint256 agentId) public view override returns (string memory) {
        _requireOwned(agentId);
        return _agentURIs[agentId];
    }
}
