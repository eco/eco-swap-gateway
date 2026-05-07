import {
  encodeAbiParameters,
  encodePacked,
  erc20Abi,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { portalAbi } from "../../abi/portal.js";
import { hashReward } from "../../common.js";
import {
  BASE_HYPER_PROVER,
  PORTAL_BASE,
  SOLANA_HYPERLANE_DOMAIN,
  SVM_HYPER_PROVER,
  TOSHI_BASE,
  USDC_BASE,
} from "../config.js";
import type { BucketEntry } from "../types.js";
import { sleep } from "../util/tx.js";

// Minimal HyperProver surface — just the fee-quote view used before
// `fulfillAndProve`. Matches `MessageBridgeProver.fetchFee(domainID,
// encodedProofs, data)` in solver-v2's `message-bridge-prover.abi.ts`.
const hyperProverFetchFeeAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "fetchFee",
    inputs: [
      { name: "domainID", type: "uint64" },
      { name: "encodedProofs", type: "bytes" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Act as solver on Base: approve Portal, call `fulfillAndProve` with the
 * Hyperlane dispatch fee as msg.value. Returns the TOSHI delivered to
 * `toshiRecipient` parsed from the receipt's Transfer logs.
 *
 * Commits to the SVM-native reward hash (Borsh) — keeping reward_hash
 * (and therefore intent_hash) byte-identical across chains, which the
 * cross-chain prove → withdraw path requires.
 */
export async function fulfillOnBase(params: {
  baseWallet: WalletClient;
  basePublic: PublicClient;
  intentHash: Hex;
  entry: BucketEntry;
  claimant32: Hex; // 32-byte claimant Base stores and Hyperlane relays to Solana
  toshiRecipient: Address;
}): Promise<bigint> {
  const {
    baseWallet,
    basePublic,
    intentHash,
    entry,
    claimant32,
    toshiRecipient,
  } = params;

  const rewardHash = ("0x" +
    Buffer.from(hashReward(entry.reward)).toString("hex")) as Hex;

  // HyperProver proof payload: `abi.encode((bytes32 sourceChainProver,
  // bytes metadata, address hook))`. Only `sourceChainProver` carries
  // meaning here — it tells the Base HyperProver which Solana program to
  // route the cross-chain Hyperlane message to.
  const svmProver32 = ("0x" +
    Buffer.from(SVM_HYPER_PROVER.toBytes()).toString("hex")) as Hex;
  const proofData = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "sourceChainProver", type: "bytes32" },
          { name: "metadata", type: "bytes" },
          { name: "hook", type: "address" },
        ],
      },
    ],
    [{ sourceChainProver: svmProver32, metadata: "0x", hook: zeroAddress }],
  );

  // Quote the Hyperlane mailbox dispatch fee. `encodedProofs` layout matches
  // solver-v2's `evm.reader.service.ts` — packed(u64 domainID, bytes32
  // intentHash, bytes32 claimant).
  const encodedProofs = encodePacked(
    ["uint64", "bytes32", "bytes32"],
    [SOLANA_HYPERLANE_DOMAIN, intentHash, claimant32],
  );
  const proverFee = (await basePublic.readContract({
    address: BASE_HYPER_PROVER,
    abi: hyperProverFetchFeeAbi,
    functionName: "fetchFee",
    args: [SOLANA_HYPERLANE_DOMAIN, encodedProofs, proofData],
  })) as bigint;
  console.log(
    `Fulfilling on Base (routeAmount=${entry.routeAmount} USDC 6d; proverFee=${proverFee} wei)…`,
  );

  const approveHash = await baseWallet.writeContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "approve",
    args: [PORTAL_BASE, entry.routeAmount],
    account: baseWallet.account!,
    chain: baseWallet.chain!,
  });
  await basePublic.waitForTransactionReceipt({ hash: approveHash });

  // Some RPCs (Alchemy/QuickNode) keep approve in their pending pool for a
  // beat after mining. Without an explicit nonce viem asks for the pending
  // count and can reuse approve's slot, tripping "replacement transaction
  // underpriced" on the next send. Wait, then lock to post-approve `latest`.
  await sleep(2_000);
  const fulfillNonce = await basePublic.getTransactionCount({
    address: baseWallet.account!.address,
    blockTag: "latest",
  });

  // Alchemy's eth_estimateGas chokes on fulfill's nested-bytes[] return with
  // a spurious "-32602 Invalid params"; pass gas directly to bypass
  // estimation. 800k covers fulfill (~287k) plus Hyperlane dispatch overhead.
  const fulfillHash = await baseWallet.writeContract({
    address: PORTAL_BASE,
    abi: portalAbi,
    functionName: "fulfillAndProve",
    args: [
      intentHash,
      entry.routeStruct,
      rewardHash,
      claimant32,
      BASE_HYPER_PROVER,
      SOLANA_HYPERLANE_DOMAIN,
      proofData,
    ],
    account: baseWallet.account!,
    chain: baseWallet.chain!,
    value: proverFee,
    gas: 800_000n,
    nonce: fulfillNonce,
  });
  console.log(`  fulfillAndProve tx: ${fulfillHash}`);

  const receipt = await basePublic.waitForTransactionReceipt({
    hash: fulfillHash,
  });
  if (receipt.status !== "success") {
    throw new Error(`fulfillAndProve reverted (tx ${fulfillHash})`);
  }

  // Parse TOSHI Transfer events from *this* receipt — don't trust
  // getBalance; RPC replicas lag.
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: "Transfer",
    logs: receipt.logs,
  });
  let delivered = 0n;
  for (const log of transfers) {
    if (
      log.address.toLowerCase() === TOSHI_BASE.toLowerCase() &&
      log.args.to?.toLowerCase() === toshiRecipient.toLowerCase()
    ) {
      delivered += log.args.value ?? 0n;
    }
  }
  return delivered;
}
