import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DISCRIMINATOR,
  PORTAL_PROGRAM_ID,
  Reward,
  encodeReward,
  proofCloserPda,
  vaultAta,
  vaultPda,
  withdrawnMarkerPda,
} from "../../common.js";
import { BASE_CHAIN_ID, SVM_HYPER_PROVER, USDC_SOLANA } from "../config.js";
import { sendAndConfirm, sleep } from "../util/tx.js";

const HYPER_PROVER_PDA_PAYER_SEED = Buffer.from("pda_payer");

/** HyperProver `pda_payer_pda` — receives lamports freed by `close_proof`. */
function hyperProverPdaPayerPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [HYPER_PROVER_PDA_PAYER_SEED],
    SVM_HYPER_PROVER,
  );
}

/**
 * Proof PDA under the HyperProver (cross-chain proof). `common.ts`'s
 * `proofPda` hardcodes the local-prover, which is correct for flash-fulfill
 * but not for the Hyperlane-delivered proof.
 */
function hyperProverProofPda(intentHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("proof"), Buffer.from(intentHash)],
    SVM_HYPER_PROVER,
  );
}

/**
 * Portal's `withdraw` instruction. Accounts mirror `Withdraw` in
 * `eco-routes-svm/programs/portal/src/instructions/withdraw.rs`; remaining
 * accounts are `[from, to, mint]` per reward token (chunk size = 3) followed
 * by prover-specific `close_proof` extras (HyperProver needs `pda_payer`).
 */
function buildWithdrawInstruction(params: {
  payer: PublicKey;
  claimant: PublicKey;
  vaultPda: PublicKey;
  proofPda: PublicKey;
  proofCloserPda: PublicKey;
  proverProgram: PublicKey;
  withdrawnMarkerPda: PublicKey;
  destination: bigint;
  routeHash: Uint8Array;
  reward: Reward;
  transfers: Array<{ from: PublicKey; to: PublicKey; mint: PublicKey }>;
  closeProofExtras: PublicKey[];
}): TransactionInstruction {
  const destBuf = Buffer.alloc(8);
  destBuf.writeBigUInt64LE(params.destination, 0);
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATOR.withdraw),
    destBuf,
    Buffer.from(params.routeHash),
    Buffer.from(encodeReward(params.reward)),
  ]);

  const keys = [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: params.claimant, isSigner: false, isWritable: true },
    { pubkey: params.vaultPda, isSigner: false, isWritable: true },
    { pubkey: params.proofPda, isSigner: false, isWritable: true },
    { pubkey: params.proofCloserPda, isSigner: false, isWritable: false },
    { pubkey: params.proverProgram, isSigner: false, isWritable: false },
    { pubkey: params.withdrawnMarkerPda, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  for (const t of params.transfers) {
    keys.push({ pubkey: t.from, isSigner: false, isWritable: true });
    keys.push({ pubkey: t.to, isSigner: false, isWritable: true });
    keys.push({ pubkey: t.mint, isSigner: false, isWritable: false });
  }
  for (const extra of params.closeProofExtras) {
    keys.push({ pubkey: extra, isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({
    programId: PORTAL_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Wait for the Hyperlane relay to land the proof PDA (written by the SVM
 * HyperProver's `handle` on message receipt), then call Portal's `withdraw`
 * to pull the reward USDC from the vault into the user's ATA.
 */
export async function withdrawFromSource(params: {
  connection: Connection;
  userKey: Keypair;
  userRewardAta: PublicKey;
  intentHash: Uint8Array;
  routeHash: Uint8Array;
  rewardAmount: bigint;
  winningReward: Reward;
}): Promise<void> {
  const {
    connection,
    userKey,
    userRewardAta,
    intentHash,
    routeHash,
    rewardAmount,
    winningReward,
  } = params;
  const user = userKey.publicKey;

  const [vaultPdaPk] = vaultPda(intentHash);
  const vaultUsdcAta = vaultAta(vaultPdaPk, USDC_SOLANA, TOKEN_PROGRAM_ID);
  const [proofPdaPk] = hyperProverProofPda(intentHash);
  const [proofCloserPk] = proofCloserPda();
  const [withdrawnMarkerPk] = withdrawnMarkerPda(intentHash);
  const [pdaPayerPk] = hyperProverPdaPayerPda();

  await pollForProof(connection, proofPdaPk);

  const beforeBal = BigInt(
    (await connection.getTokenAccountBalance(userRewardAta, "confirmed")).value
      .amount,
  );

  const withdrawIx = buildWithdrawInstruction({
    payer: user,
    claimant: user,
    vaultPda: vaultPdaPk,
    proofPda: proofPdaPk,
    proofCloserPda: proofCloserPk,
    proverProgram: SVM_HYPER_PROVER,
    withdrawnMarkerPda: withdrawnMarkerPk,
    destination: BASE_CHAIN_ID,
    routeHash,
    reward: winningReward,
    transfers: [{ from: vaultUsdcAta, to: userRewardAta, mint: USDC_SOLANA }],
    closeProofExtras: [pdaPayerPk],
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      withdrawIx,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([userKey]);

  console.log("Sending withdraw tx on Solana…");
  const sig = await sendAndConfirm(connection, tx);
  console.log(`  withdraw tx: ${sig}`);

  const afterBal = BigInt(
    (await connection.getTokenAccountBalance(userRewardAta, "confirmed")).value
      .amount,
  );
  console.log(
    `  USDC claimed: ${afterBal - beforeBal} (expected ${rewardAmount})`,
  );
}

/** Poll up to ~2min for the Hyperlane-delivered proof PDA. */
async function pollForProof(
  connection: Connection,
  proofPdaPk: PublicKey,
): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt++) {
    const info = await connection.getAccountInfo(proofPdaPk, "confirmed");
    if (info) return;
    if (attempt === 0) {
      console.log(
        `Proof PDA ${proofPdaPk.toBase58()} not yet present; polling every 5s…`,
      );
    }
    await sleep(5_000);
  }
  throw new Error(
    `Proof PDA ${proofPdaPk.toBase58()} never landed — Hyperlane relay timed out. ` +
      `The vault is still funded; re-run withdraw once the proof account exists.`,
  );
}
