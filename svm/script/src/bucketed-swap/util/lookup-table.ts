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

async function sendTx(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
): Promise<void> {
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  await sendAndConfirm(connection, tx);
}
