// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice EIP-3009 (USDC-style) signed transfers. tUSD8 on Aevum implements this.
interface IERC3009Receive {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title AllowanceVault
/// @notice An owner deposits tUSD8 once and gives each AI agent key a bounded allowance:
///         a cap per payment, a cap per 24h window, an allowlist of payees, an expiry and an
///         instant revoke. Agents never hold the owner's funds or keys.
///
///         Every payment carries a `ref` chosen by the payee (for example the hash of a quote id).
///         A (payee, ref) pair can be paid once, and the receipt stays on chain, so a seller can
///         deliver exactly once per payment and anyone can audit what was paid for.
///
///         Agents pay either by sending `spend` themselves, or by signing an EIP-712 `Spend`
///         message that anyone (usually the seller) submits with `spendWithSig`. The second path
///         means an agent key needs no gas token at all.
/// @dev    Post-quantum: each grant can commit to the hash of an ML-DSA-65 public key. QDay has no
///         ML-DSA verify precompile until Phase 2, so the vault only stores the commitment; the
///         seller checks ML-DSA signatures off chain against it.
contract AllowanceVault is EIP712 {
    using SafeERC20 for IERC20;

    struct Grant {
        address owner;
        uint64 expiry;
        bool revoked;
        uint64 windowStart;
        uint128 perTxCap;
        uint128 dailyCap;
        uint128 spentInWindow;
        uint256 agentId;
        bytes32 pqKeyHash;
    }

    struct Receipt {
        address agent;
        uint64 paidAt;
        address owner;
        uint256 agentId;
        uint256 amount;
    }

    bytes32 public constant SPEND_TYPEHASH =
        keccak256("Spend(address agent,address payee,uint256 amount,bytes32 ref,uint256 deadline)");
    uint256 public constant WINDOW = 1 days;

    IERC20 public immutable token;
    IERC721 public immutable identity;

    mapping(address owner => uint256) public balanceOf;
    mapping(address agent => Grant) private _grants;
    mapping(address agent => mapping(address payee => bool)) public payeeAllowed;
    mapping(address payee => mapping(bytes32 ref => Receipt)) private _receipts;

    event Deposited(address indexed owner, uint256 amount);
    event Withdrawn(address indexed owner, uint256 amount);
    event Granted(
        address indexed owner,
        address indexed agent,
        uint256 indexed agentId,
        uint128 perTxCap,
        uint128 dailyCap,
        uint64 expiry,
        bytes32 pqKeyHash
    );
    event PayeeSet(address indexed agent, address indexed payee, bool allowed);
    event Revoked(address indexed owner, address indexed agent);
    event PqKeyRotated(address indexed agent, bytes32 oldHash, bytes32 newHash);
    event Spent(
        address indexed payee,
        bytes32 indexed ref,
        address indexed agent,
        address owner,
        uint256 agentId,
        uint256 amount
    );

    error ZeroAddress();
    error ZeroAmount();
    error BadCaps();
    error BadExpiry();
    error NotIdentityOwner(uint256 agentId);
    error AgentOwnedByOther(address agent);
    error NotGrantOwner(address agent);
    error NoGrant(address agent);
    error GrantRevoked(address agent);
    error GrantExpired(address agent, uint64 expiry);
    error PayeeNotAllowed(address agent, address payee);
    error OverPerTxCap(uint256 amount, uint256 cap);
    error OverDailyCap(uint256 amount, uint256 remaining);
    error InsufficientVaultBalance(uint256 amount, uint256 balance);
    error RefAlreadyPaid(address payee, bytes32 ref);
    error SignatureExpired(uint256 deadline);
    error BadSignature();

    constructor(IERC20 token_, IERC721 identity_) EIP712("AllowanceVault", "1") {
        if (address(token_) == address(0) || address(identity_) == address(0)) revert ZeroAddress();
        token = token_;
        identity = identity_;
    }

    // ---------------------------------------------------------------- owner: funds

    /// @notice Deposit tokens you approved to this vault.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        balanceOf[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Deposit with an EIP-3009 `ReceiveWithAuthorization` signed by `from`. Anyone may submit.
    ///         Only this vault can execute a receive-authorization addressed to it, and the funds are
    ///         always credited to `from`, so a relayer cannot redirect them.
    function depositWithAuthorization(
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (amount == 0) revert ZeroAmount();
        balanceOf[from] += amount;
        emit Deposited(from, amount);
        IERC3009Receive(address(token)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, nonce, v, r, s
        );
    }

    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (amount > bal) revert InsufficientVaultBalance(amount, bal);
        balanceOf[msg.sender] = bal - amount;
        emit Withdrawn(msg.sender, amount);
        token.safeTransfer(msg.sender, amount);
    }

    // ---------------------------------------------------------------- owner: grants

    /// @notice Create or update the allowance of `agent` (an agent's signing key).
    /// @param agentId Identity of the agent in the IdentityRegistry. Caller must own it.
    /// @param payees Payees to allow (added to any already allowed; use `setPayee` to remove).
    /// @param pqKeyHash keccak256 of the agent's ML-DSA-65 public key, or 0 for none.
    function grant(
        address agent,
        uint256 agentId,
        uint128 perTxCap,
        uint128 dailyCap,
        uint64 expiry,
        address[] calldata payees,
        bytes32 pqKeyHash
    ) external {
        if (agent == address(0)) revert ZeroAddress();
        if (perTxCap == 0 || perTxCap > dailyCap) revert BadCaps();
        if (expiry <= block.timestamp) revert BadExpiry();
        if (identity.ownerOf(agentId) != msg.sender) revert NotIdentityOwner(agentId);

        Grant storage g = _grants[agent];
        if (g.owner != address(0) && g.owner != msg.sender) revert AgentOwnedByOther(agent);

        // Spend already counted in the current window stays counted, so re-granting never resets a cap.
        g.owner = msg.sender;
        g.agentId = agentId;
        g.perTxCap = perTxCap;
        g.dailyCap = dailyCap;
        g.expiry = expiry;
        g.revoked = false;
        if (g.pqKeyHash != pqKeyHash) {
            emit PqKeyRotated(agent, g.pqKeyHash, pqKeyHash);
            g.pqKeyHash = pqKeyHash;
        }
        emit Granted(msg.sender, agent, agentId, perTxCap, dailyCap, expiry, pqKeyHash);

        for (uint256 i = 0; i < payees.length; i++) {
            _setPayee(agent, payees[i], true);
        }
    }

    function setPayee(address agent, address payee, bool allowed) external {
        _onlyGrantOwner(agent);
        _setPayee(agent, payee, allowed);
    }

    /// @notice Stop `agent` from spending, effective in the same block.
    function revoke(address agent) external {
        _onlyGrantOwner(agent);
        _grants[agent].revoked = true;
        emit Revoked(msg.sender, agent);
    }

    /// @notice Point the grant at a new ML-DSA-65 public key hash (key rotation).
    function rotatePqKey(address agent, bytes32 newHash) external {
        _onlyGrantOwner(agent);
        Grant storage g = _grants[agent];
        emit PqKeyRotated(agent, g.pqKeyHash, newHash);
        g.pqKeyHash = newHash;
    }

    // ---------------------------------------------------------------- agent: pay

    /// @notice Pay `amount` to `payee` for `ref`, as the agent (msg.sender).
    function spend(address payee, uint256 amount, bytes32 ref) external {
        _spend(msg.sender, payee, amount, ref);
    }

    /// @notice Pay on behalf of `agent` with its EIP-712 `Spend` signature. Anyone may submit.
    /// @dev Replay is impossible: each (payee, ref) can be paid once, and the signature covers both.
    function spendWithSig(
        address agent,
        address payee,
        uint256 amount,
        bytes32 ref,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        bytes32 digest = spendDigest(agent, payee, amount, ref, deadline);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != agent) revert BadSignature();
        _spend(agent, payee, amount, ref);
    }

    // ---------------------------------------------------------------- views

    function spendDigest(address agent, address payee, uint256 amount, bytes32 ref, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(SPEND_TYPEHASH, agent, payee, amount, ref, deadline)));
    }

    function grantOf(address agent) external view returns (Grant memory) {
        return _grants[agent];
    }

    /// @notice How much `agent` can still spend in the current window (0 if it cannot spend at all).
    function remainingToday(address agent) public view returns (uint256) {
        Grant storage g = _grants[agent];
        if (g.owner == address(0) || g.revoked || block.timestamp >= g.expiry) return 0;
        uint256 spent = block.timestamp >= uint256(g.windowStart) + WINDOW ? 0 : g.spentInWindow;
        uint256 left = g.dailyCap - spent;
        uint256 bal = balanceOf[g.owner];
        return left < bal ? left : bal;
    }

    /// @notice The receipt for (payee, ref). `agent == address(0)` means not paid.
    function receiptOf(address payee, bytes32 ref) external view returns (Receipt memory) {
        return _receipts[payee][ref];
    }

    // ---------------------------------------------------------------- internals

    function _spend(address agent, address payee, uint256 amount, bytes32 ref) private {
        Grant storage g = _grants[agent];
        if (g.owner == address(0)) revert NoGrant(agent);
        if (g.revoked) revert GrantRevoked(agent);
        if (block.timestamp >= g.expiry) revert GrantExpired(agent, g.expiry);
        if (!payeeAllowed[agent][payee]) revert PayeeNotAllowed(agent, payee);
        if (amount == 0) revert ZeroAmount();
        if (amount > g.perTxCap) revert OverPerTxCap(amount, g.perTxCap);

        if (block.timestamp >= uint256(g.windowStart) + WINDOW) {
            g.windowStart = uint64(block.timestamp);
            g.spentInWindow = 0;
        }
        uint256 left = g.dailyCap - g.spentInWindow;
        if (amount > left) revert OverDailyCap(amount, left);

        Receipt storage rc = _receipts[payee][ref];
        if (rc.agent != address(0)) revert RefAlreadyPaid(payee, ref);

        address owner = g.owner;
        uint256 bal = balanceOf[owner];
        if (amount > bal) revert InsufficientVaultBalance(amount, bal);

        g.spentInWindow += uint128(amount);
        balanceOf[owner] = bal - amount;
        _receipts[payee][ref] = Receipt({
            agent: agent,
            paidAt: uint64(block.timestamp),
            owner: owner,
            agentId: g.agentId,
            amount: amount
        });
        emit Spent(payee, ref, agent, owner, g.agentId, amount);

        token.safeTransfer(payee, amount);
    }

    function _setPayee(address agent, address payee, bool allowed) private {
        if (payee == address(0)) revert ZeroAddress();
        payeeAllowed[agent][payee] = allowed;
        emit PayeeSet(agent, payee, allowed);
    }

    function _onlyGrantOwner(address agent) private view {
        address owner = _grants[agent].owner;
        if (owner == address(0)) revert NoGrant(agent);
        if (owner != msg.sender) revert NotGrantOwner(agent);
    }
}
