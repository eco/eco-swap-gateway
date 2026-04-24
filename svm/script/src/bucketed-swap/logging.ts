import { PENGU_INPUT_HUMAN } from "./config.js";
import type { BucketEntry, Context } from "./types.js";

export function logHeader(ctx: Context): void {
  console.log(`User (Solana):   ${ctx.userKey.publicKey.toBase58()}`);
  console.log(`Input:           ${PENGU_INPUT_HUMAN} PENGU`);
  console.log(`Destination:     Base (chain id 8453)`);
  console.log();
}

export function logBuckets(entries: BucketEntry[]): void {
  for (const [i, e] of entries.entries()) {
    const rh = Buffer.from(e.bucket.routeHash).toString("hex");
    console.log(
      `  [${i}] reward(src,6d)=${e.bucket.rewardAmount}  route(dst,6d)=${e.routeAmount}  routeHash=0x${rh}`,
    );
  }
  console.log();
}

export function logSwapSlippage(
  label: string,
  args: {
    expectedOut: bigint;
    minOut: bigint;
    actualOut: bigint;
    decimals: number;
    symbol: string;
  },
): void {
  const { expectedOut, minOut, actualOut, decimals, symbol } = args;
  const human = (v: bigint) =>
    (Number(v) / 10 ** decimals).toFixed(Math.min(decimals, 8));
  const realBps =
    expectedOut === 0n
      ? 0n
      : ((expectedOut - actualOut) * 10_000n) / expectedOut;
  const configBps =
    expectedOut === 0n ? 0n : ((expectedOut - minOut) * 10_000n) / expectedOut;
  console.log(label);
  console.log(`  quoted:  ${expectedOut} (${human(expectedOut)} ${symbol})`);
  console.log(
    `  minOut:  ${minOut}   (${human(minOut)} ${symbol}) [config ${configBps}bps]`,
  );
  console.log(`  actual:  ${actualOut}   (${human(actualOut)} ${symbol})`);
  console.log(
    `  real slippage: ${realBps}bps (${(Number(realBps) / 100).toFixed(2)}%)`,
  );
  console.log();
}
