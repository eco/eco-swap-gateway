import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_IX_URL = "https://lite-api.jup.ag/swap/v1/swap-instructions";

export interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
  }>;
  // Many more fields are returned; we only read the above.
}

interface JupiterIx {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}

interface JupiterSwapInstructions {
  setupInstructions?: JupiterIx[];
  swapInstruction: JupiterIx;
  cleanupInstruction?: JupiterIx;
  addressLookupTableAddresses: string[];
}

export async function fetchJupiterQuote(params: {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: bigint;
  slippageBps: number;
}): Promise<JupiterQuote> {
  const url = new URL(JUPITER_QUOTE_URL);
  url.searchParams.set("inputMint", params.inputMint.toBase58());
  url.searchParams.set("outputMint", params.outputMint.toBase58());
  url.searchParams.set("amount", params.amount.toString());
  url.searchParams.set("slippageBps", params.slippageBps.toString());
  url.searchParams.set("restrictIntermediateTokens", "true");
  // Single-hop routes only: multi-hop swaps bring in extra ALTs + accounts
  // that push the [open, Jupiter, close_and_select] tx past the 1232-byte
  // Solana packet limit.
  url.searchParams.set("onlyDirectRoutes", "true");
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Jupiter /quote failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as JupiterQuote;
}

/**
 * Fetch the swap instruction + its ALTs. Fails fast if Jupiter returns a
 * setup/cleanup ix — this flow only supports a single swap ix in the Route.
 */
export async function fetchJupiterSwap(params: {
  connection: Connection;
  quote: JupiterQuote;
  authority: PublicKey; // executor PDA (portal CPI-signs during fulfill)
  destinationTokenAccount: PublicKey;
}): Promise<{
  swapIx: TransactionInstruction;
  alts: AddressLookupTableAccount[];
}> {
  const body = {
    quoteResponse: params.quote,
    userPublicKey: params.authority.toBase58(),
    destinationTokenAccount: params.destinationTokenAccount.toBase58(),
    wrapAndUnwrapSol: false,
    useSharedAccounts: true,
    // We own the compute-budget ix — suppress Jupiter's default injection
    // so the final tx doesn't carry two SetComputeUnitLimit calls.
    computeUnitPriceMicroLamports: "auto",
  };
  const res = await fetch(JUPITER_SWAP_IX_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `Jupiter /swap-instructions failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as JupiterSwapInstructions;
  if (data.setupInstructions?.length || data.cleanupInstruction) {
    throw new Error(
      "Jupiter returned setup/cleanup ixs; this flow only supports a single swap ix in the Route",
    );
  }

  const alts: AddressLookupTableAccount[] = [];
  for (const addr of data.addressLookupTableAddresses) {
    const acct = await params.connection
      .getAddressLookupTable(new PublicKey(addr))
      .then((r) => r.value);
    if (acct) alts.push(acct);
  }

  return { swapIx: toWeb3Ix(data.swapInstruction), alts };
}

function toWeb3Ix(ix: JupiterIx): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}
