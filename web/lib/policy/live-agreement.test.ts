import { describe, expect, it } from "vitest";
import { readEvaluatePayment } from "@/lib/chain/adapter";
import { createReadClient } from "@/lib/chain/adapter";
import { evaluateCreation } from "@/lib/policy/evaluate";
import { MIL_E_POLICY, ReasonCode, RECIPIENT_MILESTONE_E, STRANGER_ADDRESS, TREASURY_ADDRESS } from "@/lib/policy/types";
import { readFileSync } from "node:fs";

/**
 * Semantic-fidelity check against the LIVE contract.
 *
 * The table tests prove our evaluator implements what we *believe* the contract does. This
 * proves what the contract *actually* does, by calling its own `evaluatePayment` view with
 * the same inputs and requiring identical verdicts. It is the one test that would catch a
 * misreading of the Solidity.
 *
 * Skipped (not failed) when no RPC URL is configured, so an offline `npm test` stays green
 * while a live run still gives the real guarantee. `describe.skipIf` keeps that explicit
 * rather than hiding it behind a try/catch.
 */

function envValue(key: string): string | undefined {
  const fromProcess = process.env[key];
  if (fromProcess) return fromProcess;
  for (const file of ["../contracts/.env", ".env"]) {
    try {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && m[1] === key) return m[2].trim();
      }
    } catch {
      /* try next */
    }
  }
  return undefined;
}

const rpcUrl = envValue("ARBITRUM_SEPOLIA_RPC_URL") ?? envValue("RPC_URL");

const DAY = 20726n;
const MONTH = 24321n;
const RECIPIENT = { approved: true, category: "MILESTONE-E" };

function counters(balance: bigint, over: Record<string, Record<string, bigint>> = {}) {
  return {
    reservedDay: over.reservedDay ?? {},
    reservedMonth: over.reservedMonth ?? {},
    spentDay: over.spentDay ?? {},
    spentMonth: over.spentMonth ?? {},
    lifetimeReserved: 0n,
    lifetimeSpent: 60_000_000n,
    balance,
    paused: false,
  };
}

describe.skipIf(!rpcUrl)("live evaluatePayment agrees with the off-chain engine", () => {
  const client = rpcUrl ? createReadClient(rpcUrl) : (undefined as never);

  // Each row is a (to, amount) probe. The contract's own view is the oracle; our evaluator
  // must return the same allowed/reason for the same live state. The `recipient` state must
  // describe the SAME address as `to` — passing an "approved" state for a stranger address
  // would compare the contract against a scenario that does not exist.
  const probes: {
    name: string;
    to: string;
    amount: bigint;
    offchainBalance: bigint;
    recipient: { approved: boolean; category: string };
  }[] = [
    { name: "small allowlisted amount", to: RECIPIENT_MILESTONE_E, amount: 1n, offchainBalance: 140_000_000n, recipient: RECIPIENT },
    { name: "auto-approve cap exactly", to: RECIPIENT_MILESTONE_E, amount: 25_000_000n, offchainBalance: 140_000_000n, recipient: RECIPIENT },
    { name: "above auto-approve but within single-tx", to: RECIPIENT_MILESTONE_E, amount: 50_000_000n, offchainBalance: 140_000_000n, recipient: RECIPIENT },
    { name: "above single-tx limit", to: RECIPIENT_MILESTONE_E, amount: 100_000_001n, offchainBalance: 140_000_000n, recipient: RECIPIENT },
    { name: "zero amount", to: RECIPIENT_MILESTONE_E, amount: 0n, offchainBalance: 140_000_000n, recipient: RECIPIENT },
    { name: "zero recipient", to: "0x0000000000000000000000000000000000000000", amount: 1n, offchainBalance: 140_000_000n, recipient: RECIPIENT },
    { name: "self transfer", to: TREASURY_ADDRESS, amount: 1n, offchainBalance: 140_000_000n, recipient: RECIPIENT },
    { name: "unknown recipient (not on allowlist)", to: STRANGER_ADDRESS, amount: 1n, offchainBalance: 140_000_000n, recipient: { approved: false, category: "0x" } },
    { name: "exceeds live balance", to: RECIPIENT_MILESTONE_E, amount: 200_000_000n, offchainBalance: 140_000_000n, recipient: RECIPIENT },
  ];

  for (const probe of probes) {
    it(probe.name, async () => {
      const onchain = await readEvaluatePayment(client, TREASURY_ADDRESS, probe.to, probe.amount);
      const offchain = evaluateCreation({
        to: probe.to,
        amount: probe.amount,
        policy: MIL_E_POLICY,
        counters: counters(probe.offchainBalance),
        recipient: probe.recipient,
        dayKey: DAY,
        monthKey: MONTH,
      });
      // The contract's `allowed` means "would not be Blocked", which is our `allowed`.
      expect(offchain.allowed).toBe(onchain.allowed);
      expect(offchain.reason).toBe(onchain.reason as ReasonCode);
    });
  }
});
