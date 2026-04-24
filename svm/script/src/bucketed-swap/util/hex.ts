import { randomFillSync } from "node:crypto";

export function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex.replace(/^0x/, ""), "hex"));
}

export function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function randomSalt(): Uint8Array {
  const out = new Uint8Array(32);
  randomFillSync(out);
  return out;
}
