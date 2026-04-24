import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { sendAndConfirm, sleep } from "./tx.js";

// v0 tx packet caps at 1232B; each ALT extend entry is 32B. With ix/account
// framing, ~20 addresses per extend leaves headroom for the create ix in tx 1.
const ALT_EXTEND_CHUNK = 20;

/**
 * Create an Address Lookup Table and extend it with the given accounts,
 * chunking across txs as needed. Returns the resolved ALT account only once
 * the lookup table is active and populated.
 */
export async function createLookupTable(
  connection: Connection,
  payer: Keypair,
  accounts: PublicKey[],
): Promise<AddressLookupTableAccount> {
  const slot = await connection.getSlot({ commitment: "finalized" });
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });

  const first = accounts.slice(0, ALT_EXTEND_CHUNK);
  const rest: PublicKey[][] = [];
  for (let i = ALT_EXTEND_CHUNK; i < accounts.length; i += ALT_EXTEND_CHUNK) {
    rest.push(accounts.slice(i, i + ALT_EXTEND_CHUNK));
  }

  // Tx 1: create + first extend chunk.
  {
    const ixs: TransactionInstruction[] = [createIx];
    if (first.length > 0) {
      ixs.push(
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: altAddress,
          authority: payer.publicKey,
          payer: payer.publicKey,
          addresses: first,
        }),
      );
    }
    await sendTx(connection, payer, ixs);
  }

  // Subsequent txs: one extend per chunk.
  for (const chunk of rest) {
    const ix = AddressLookupTableProgram.extendLookupTable({
      lookupTable: altAddress,
      authority: payer.publicKey,
      payer: payer.publicKey,
      addresses: chunk,
    });
    await sendTx(connection, payer, [ix]);
  }

  // ALTs need at least one slot after creation before they can be used in
  // another tx. Poll until it's populated with all expected entries.
  for (let i = 0; i < 30; i++) {
    const acct = await connection
      .getAddressLookupTable(altAddress)
      .then((r) => r.value);
    if (acct && acct.state.addresses.length >= accounts.length) return acct;
    await sleep(500);
  }
  throw new Error(`ALT ${altAddress.toBase58()} did not activate within 15s`);
}

/**
 * Mark one or more ALTs for deletion. This is PHASE 1 of Solana's two-phase
 * ALT close:
 *
 *   1. `deactivateLookupTable` — immediate, idempotent-ish (repeat calls no-op
 *      after the table is already deactivated). Sets the "deactivation slot"
 *      on the ALT account. After this, the ALT can no longer be used as a
 *      loaded-addresses source in v0 transactions.
 *
 *   2. `closeLookupTable` — only succeeds once the current slot is >=
 *      `deactivation_slot + 513` (~3–4 minutes on mainnet). Refunds the
 *      account's rent-exempt reserve to the chosen recipient.
 *
 * We do ONLY phase 1 here — the run cannot block for 3–4 min without
 * disrupting throughput on a production server. Phase 2 MUST be handled by
 * an out-of-band cron job (see `closeAbandonedLookupTables` below / the
 * separate sweeper script) that:
 *
 *   - Enumerates ALTs owned by the service wallet (`getProgramAccounts` on
 *     the AddressLookupTable program, filtered by authority).
 *   - Filters to ALTs whose `state.deactivationSlot != u64::MAX` AND whose
 *     cooldown has elapsed (current slot ≥ deactivationSlot + 513).
 *   - Sends `closeLookupTable` for each, recipient = service wallet.
 *
 * Why it matters: every demo run creates two fresh ALTs (bucket ALT with 2N
 * entries, flash-fulfill ALT with ~25 entries). Rent per run is ~0.008 SOL
 * (~$1.50 at $180/SOL). Across high-volume production traffic this is a
 * non-trivial drain on the solver's SOL budget; leaving ALTs un-reaped is
 * effectively a slow-motion leak.
 *
 * Bundling both deactivations into a single tx (instead of one-per-ALT)
 * saves a signature + blockhash round-trip. Instruction size is tiny
 * (~36B per deactivate ix) so there's no packet-limit concern.
 */
export async function deactivateLookupTables(
  connection: Connection,
  authority: Keypair,
  alts: AddressLookupTableAccount[],
): Promise<string> {
  if (alts.length === 0) {
    throw new Error("deactivateLookupTables called with empty ALT list");
  }
  const instructions = alts.map((alt) =>
    AddressLookupTableProgram.deactivateLookupTable({
      lookupTable: alt.key,
      authority: authority.publicKey,
    }),
  );
  return await sendTx(connection, authority, instructions);
}

async function sendTx(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return await sendAndConfirm(connection, tx);
}
