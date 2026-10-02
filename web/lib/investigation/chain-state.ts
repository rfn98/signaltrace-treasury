/**
 * Milestone I — read-only chain access.
 *
 * Every call below is a `view`/`pure` read from the Milestone G adapter. There is no private
 * client, no key, and no write path, so an investigation cannot move funds even if a bug or a
 * hostile input reached this module. That property is asserted by an architecture test rather
 * than left to this comment.
 *
 * The reader also performs the single most important check in Milestone I: it asks the
 * CONTRACT for its own verdict via `evaluatePayment`. Milestone G mirrors Treasury.sol's rules
 * off-chain, and a mirror is only trustworthy while it still agrees with the thing it mirrors.
 * Comparing the two at investigation time turns a silent divergence into a loud one.
 */
import {
  createReadClient,
  readChainSnapshot,
  readCurrentCommitted,
  readEvaluatePayment,
  readRecipient,
} from "@/lib/chain/adapter";
import type { ChainContext, ChainStateReader } from "./types";

/**
 * Renders an on-chain `bytes32` field as text when it really is text.
 *
 * `category` and `paymentRef` are `bytes32` on-chain. Milestone E stores `"MILESTONE-E"`
 * right-padded with zero bytes, so a raw hex string would show the model an opaque blob where a
 * human-readable label belongs. Falls back to the hex when the bytes are not valid UTF-8, so a
 * genuinely binary reference is never mangled into replacement characters.
 */
export function decodeBytes32(value: string | undefined): string {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) return value ?? "";
  const hex = value.slice(2);
  const bytes = Buffer.from(hex, "hex");
  const text = bytes.toString("utf8");
  // Round-trip test: U+FFFD appears whenever the decode consumed bytes that are not UTF-8.
  return text.includes("\uFFFD") ? value : text.replace(/\0+$/, "");
}

/** Adapts the Milestone G adapter to the narrow read Milestone I needs. */
export class ViemChainStateReader implements ChainStateReader {
  constructor(private readonly rpcUrl: string) {}

  async read(input: {
    treasuryAddress: string;
    onChainPaymentId: bigint;
  }): Promise<ChainContext> {
    const client = createReadClient(this.rpcUrl);
    const snapshot = await readChainSnapshot(client, input.treasuryAddress);
    const committed = await readCurrentCommitted(client, input.treasuryAddress);

    // Find the payment on-chain. The chain, not the database index, says what this id is.
    const payment = snapshot.payments.find((p) => p.id === input.onChainPaymentId) ?? null;
    if (!payment) {
      // Nothing to evaluate. Reported as absent rather than thrown, so the caller can say
      // "the index has this payment, the chain does not" instead of a bare dependency error.
      return { snapshot, committed, payment: null, recipient: { approved: false, category: "" }, contractVerdict: null };
    }

    const [recipient, contractVerdict] = await Promise.all([
      readRecipient(client, input.treasuryAddress, payment.recipient),
      readEvaluatePayment(client, input.treasuryAddress, payment.recipient, payment.amount),
    ]);

    return { snapshot, committed, payment, recipient, contractVerdict };
  }
}