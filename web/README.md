# SignalTrace Treasury

Policy-enforced treasury infrastructure for AI-native teams, combining deterministic spending rules, evidence-based AI investigation, and smart-contract settlement on Arbitrum.

> **AI investigates. Policy decides. Arbitrum settles.**

SignalTrace Treasury is an on-chain treasury system designed for teams that need programmable spending controls without giving an AI model direct financial authority.

The core principle is simple:

**AI can explain a decision, but it cannot make or execute the financial decision.**

---

## Why SignalTrace Treasury?

AI-native teams increasingly automate operational workflows, but financial actions still need clear controls, auditability, and human oversight.

SignalTrace Treasury separates these responsibilities:

```text
Payment Request
      │
      ▼
Evidence Builder
      │
      ▼
Deterministic Policy Engine
      │
      ├── BLOCKED
      ├── AUTO_APPROVED
      └── PENDING
              │
              ▼
       AI Investigator
              │
              ▼
     Human / Policy Decision
              │
              ▼
       Treasury Contract
              │
              ▼
      Arbitrum Settlement
```

The AI layer is advisory only. The deterministic policy engine and smart contract remain the financial authority.

---

## Key Features

- Deterministic spending policy evaluation
- Auto-approval for transactions within configured limits
- Human approval flow for transactions requiring review
- Recipient allowlisting
- Daily and monthly spending limits
- Single-transaction limits
- Reservation accounting for pending payments
- On-chain payment lifecycle
- Evidence-backed AI investigation
- AI output validation and evidence grounding
- Read-only chain reconciliation
- Arbitrum Sepolia deployment
- Database indexing without replacing blockchain authority

---

## Architecture

SignalTrace Treasury uses layered authority boundaries.

### 1. Blockchain — Financial Authority

The Solidity treasury contract is the final authority for:

- payment creation
- policy enforcement
- recipient validation
- spending limits
- approval
- rejection
- payment execution
- accounting
- token settlement

The contract re-checks critical conditions during execution.

The database and AI layer cannot override contract state.

### 2. Deterministic Policy Engine

The off-chain policy engine mirrors the contract's policy logic.

It evaluates:

- single-transaction limit
- daily limit
- monthly limit
- recipient allowlist
- treasury balance
- recipient validity
- auto-approval threshold
- reservation headroom
- payment lifecycle state

The engine produces deterministic verdicts and reason codes.

The AI model does not calculate or change these decisions.

### 3. Evidence Builder

Before an AI investigation, SignalTrace builds a canonical evidence package containing the relevant payment, treasury, policy, recipient, accounting, and reconciliation data.

Evidence is:

- deterministic
- canonicalized
- SHA-256 hashed
- explicitly scoped by authority
- validated before reaching the model

### 4. AI Investigator

The AI Investigator uses Ollama Cloud with `gpt-oss:20b`.

Its job is to explain an already-determined policy result using the supplied evidence.

It can:

- summarize why a payment requires review
- identify which checks passed or failed
- explain relevant policy constraints
- recommend human review when appropriate

It cannot:

- modify policy
- approve a payment
- reject a payment
- execute a transaction
- access private keys
- write to the blockchain

Invalid, malformed, contradictory, or ungrounded model output fails closed to `INSUFFICIENT_EVIDENCE`.

---

## Payment Lifecycle

SignalTrace Treasury uses explicit payment states:

```text
                    ┌──────────────┐
                    │   REQUEST    │
                    └──────┬───────┘
                           │
                ┌──────────┴──────────┐
                │                     │
          Policy passes         Policy requires
          auto-approval          human decision
                │                     │
                ▼                     ▼
        AUTO_APPROVED             PENDING
                │                     │
                │              ┌──────┴──────┐
                │              │             │
                │           APPROVED       REJECTED
                │              │
                └──────┬───────┘
                       │
                       ▼
                   EXECUTED
```

Payments that fail creation-time policy checks can become `BLOCKED`.

`BLOCKED`, `REJECTED`, and `EXECUTED` are terminal states.

---

## AI Safety Boundary

The most important design constraint is the separation between **decision** and **explanation**.

```text
                 ┌─────────────────────┐
                 │ Deterministic Policy│
                 │       Engine        │
                 └──────────┬──────────┘
                            │
                     Policy Verdict
                            │
                            ▼
                 ┌─────────────────────┐
                 │   AI Investigator   │
                 │   Explanation Only  │
                 └──────────┬──────────┘
                            │
                    Human-readable
                      explanation
```

The model receives the evidence and the already-established deterministic verdict.

The model cannot return a capability that changes the verdict.

This prevents a language model from becoming the security boundary for financial operations.

---

## Security Model

### No AI financial authority

The AI service has:

- no private key
- no wallet
- no blockchain write capability
- no contract execution capability
- no policy mutation capability

### Smart contract enforcement

Even if an off-chain component is compromised, the contract remains responsible for enforcing:

- caller authorization
- payment lifecycle
- spending limits
- recipient rules
- accounting
- settlement

### Fail-closed AI validation

AI output is rejected when:

- JSON is malformed
- required fields are missing
- evidence citations are invalid
- evidence is contradictory
- unsupported model output is returned
- the output attempts to exceed its advisory scope

The deterministic policy result remains unchanged.

---

## On-Chain Deployment

Current deployment target:

**Arbitrum Sepolia**

| Component | Address |
|---|---|
| Treasury | `0xD14e45a90A8b8F603db5Ed21B34Fc947D1bD88E9` |
| MockERC20 | `0xe8B0C9500D8BD0FF5528E80Ae986F2EF2B224233` |
| Chain ID | `421614` |

The current demo uses a custom `MockERC20` token on Arbitrum Sepolia to provide a deterministic, reproducible settlement path.

USDG integration is intentionally outside the current MVP scope.

---

## Verified Demo Flow

The deployed demo contains two executed payments.

### Payment 1 — Auto Approved

```text
Amount:              10,000,000 base units
Auto-approve limit:  25,000,000 base units
Policy:              AUTO_APPROVED
On-chain status:     EXECUTED
Executor:            Agent
```

Because the payment is below the auto-approval threshold, the deterministic policy engine allows the agent to execute it.

### Payment 2 — Human Approval

```text
Amount:              50,000,000 base units
Auto-approve limit:  25,000,000 base units
Policy:              PENDING
Human decision:      APPROVED
On-chain status:     EXECUTED
Approver:            Owner
Executor:            Owner
```

The payment exceeded the auto-approval threshold but remained within the configured spending limits.

The agent could create the request, but the owner had to approve it before settlement.

The live investigation page explains this decision using evidence from the chain and indexed payment data.

---

## Tech Stack

### Frontend / Application

- Next.js
- React
- TypeScript
- CSS Modules

### Backend / Data

- Next.js server-side application
- Prisma
- PostgreSQL
- Viem

### Smart Contracts

- Solidity
- Foundry
- OpenZeppelin Contracts
- SafeERC20
- AccessControl
- Pausable
- ReentrancyGuard

### AI

- Ollama Cloud
- `gpt-oss:20b`
- Structured JSON output
- Runtime schema validation
- Evidence-grounded explanations

### Blockchain

- Arbitrum Sepolia
- Chain ID `421614`

---

## Repository Structure

```text
.
├── contracts/
│   ├── src/
│   │   └── Treasury.sol
│   ├── test/
│   ├── script/
│   └── lib/
│
├── web/
│   ├── app/
│   │   ├── api/
│   │   ├── payments/
│   │   └── page.tsx
│   │
│   ├── components/
│   ├── lib/
│   │   ├── chain/
│   │   ├── evidence/
│   │   ├── investigator/
│   │   ├── policy/
│   │   ├── reconcile/
│   │   └── treasury/
│   │
│   └── prisma/
│
└── README.md
```

---

## Running Locally

### Requirements

- Node.js 22+
- npm
- Foundry
- PostgreSQL
- An Arbitrum Sepolia RPC endpoint

### Install dependencies

```bash
npm install
```

Install web dependencies:

```bash
cd web
npm install
```

### Environment

Create the required environment configuration locally.

Example:

```env
DATABASE_URL="postgresql://..."
ARBITRUM_SEPOLIA_RPC_URL="https://..."
```

For the AI Investigator:

```env
OLLAMA_BASE_URL="https://ollama.com"
OLLAMA_API_KEY="..."
OLLAMA_MODEL="gpt-oss:20b"
OLLAMA_TIMEOUT_MS="180000"
```

Never commit private keys or API keys.

---

## Database

Run Prisma migrations:

```bash
cd web
npx prisma migrate deploy
```

Seed the indexed state:

```bash
npm run db:seed
```

Verify the database:

```bash
npm run verify:db
```

The database is an index/cache layer.

It does not replace on-chain financial state.

---

## Smart Contract Tests

From the repository root:

```bash
cd contracts
forge test
```

The contract suite includes:

- authorization tests
- payment lifecycle tests
- spending-limit tests
- daily/monthly accounting
- recipient validation
- reservation accounting
- token conservation
- invariant testing

---

## Application Verification

From `web/`:

```bash
npm run test
npm run typecheck
npm run lint
npm run build
```

Run chain reconciliation:

```bash
npm run reconcile:chain
```

The reconciliation process compares indexed state against the live Arbitrum Sepolia contract without writing to the chain.

---

## Design Principles

### Blockchain is the source of financial truth

The database may index blockchain state, but it cannot override it.

### Deterministic logic before AI

Policy decisions are calculated using deterministic code before the AI model is called.

### AI explains, not decides

The AI Investigator receives evidence and explains the existing policy result.

### Execution re-checks policy

Off-chain evaluation is useful for investigation and UX, but the smart contract remains the enforcement boundary.

### Evidence over assertions

AI explanations must reference supplied evidence rather than inventing supporting facts.

### Base units for money

Financial amounts are represented as integer base units to avoid floating-point ambiguity.

---

## What Is Intentionally Out of Scope

The current build intentionally does not include:

- AI-controlled transaction execution
- AI private keys
- autonomous wallet management
- multi-chain treasury management
- USDG production settlement
- user authentication
- notifications
- portfolio management
- automated investment strategies

These constraints keep the MVP focused on the core problem: **policy-enforced treasury operations with an evidence-grounded investigation layer.**

---

## Testing Status

The project includes comprehensive validation across the contract, policy, evidence, reconciliation, AI, and application layers.

Current verification includes:

- Solidity unit and invariant tests
- deterministic policy tests
- evidence canonicalization tests
- AI output validation tests
- API tests
- reconciliation tests
- database verification
- TypeScript checks
- ESLint
- Next.js production build

The deployed Arbitrum Sepolia treasury has also been exercised through real on-chain transactions.

---

## Project Status

**MVP complete and deployed on Arbitrum Sepolia.**

The current implementation demonstrates the complete path:

```text
Request
  ↓
Deterministic Policy Evaluation
  ↓
Evidence Generation
  ↓
AI Investigation
  ↓
Human / Policy Decision
  ↓
Smart Contract Enforcement
  ↓
Arbitrum Settlement
  ↓
Chain Reconciliation
```

---

## Core Thesis

SignalTrace Treasury is not trying to make an AI model the owner of a treasury.

Instead, it gives AI a bounded role inside a system where:

**Policy provides the decision.  
Evidence provides the context.  
AI provides the explanation.  
The smart contract provides the enforcement.  
Arbitrum provides the settlement.**