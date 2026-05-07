import type { Connection, VersionedTransaction } from "@solana/web3.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Send a v0 tx and poll signature status until it confirms. Avoids the
 * `connection.confirmTransaction({blockhash, lastValidBlockHeight})` path,
 * which throws `TransactionExpiredBlockheightExceededError` the moment the
 * blockhash ages out — even if the tx lands a moment later. This poller
 * cares about the tx's *actual* status, not about the blockhash window.
 *
 * Also re-submits the raw bytes every `RESEND_MS` so forwarder-side drops
 * get retried at the same signature (cluster dedups by signature).
 */
export async function sendAndConfirm(
  connection: Connection,
  tx: VersionedTransaction,
  timeoutMs = 120_000,
): Promise<string> {
  // sendTransaction can transiently fail with "Blockhash not found" while
  // the freshly-fetched blockhash propagates across the RPC's forwarder
  // set. Retry a few times with backoff before giving up.
  let sig: string | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      sig = await connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 5,
      });
      break;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/Blockhash not found|Node is behind/.test(msg)) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  if (!sig) throw lastErr;

  const rawTx = tx.serialize();
  const RESEND_MS = 5_000;
  const start = Date.now();
  let lastResend = start;
  while (Date.now() - start < timeoutMs) {
    const s = await connection.getSignatureStatus(sig, {
      searchTransactionHistory: true,
    });
    if (s.value?.err) {
      throw new Error(`tx ${sig} failed: ${JSON.stringify(s.value.err)}`);
    }
    const c = s.value?.confirmationStatus;
    if (c === "confirmed" || c === "finalized") return sig;
    if (Date.now() - lastResend >= RESEND_MS) {
      try {
        await connection.sendRawTransaction(rawTx, {
          skipPreflight: true,
          maxRetries: 0,
        });
      } catch {
        // Re-submit errors are expected (AlreadyProcessed after confirm,
        // forwarder rate limits) — keep polling.
      }
      lastResend = Date.now();
    }
    await sleep(1500);
  }
  throw new Error(`tx ${sig} not confirmed within ${timeoutMs / 1000}s`);
}
