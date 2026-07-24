# imlil.dev: Your CTO in a box.


### 🚀 100+ Agents. 60 Seconds. Zero Limits.

**One CLI. One API Key. Infinite Staff.**

[![npm version](https://img.shields.io/npm/v/imlil.svg?style=flat-square)](https://www.npmjs.com/package/imlil)
[![Methodology: TDD](https://img.shields.io/badge/Methodology-TDD%20Strict-red.svg?style=flat-square)](https://imlil.dev/docs/tdd)
[![SaaS: Premium](https://img.shields.io/badge/Model-Pay%20As%20You%20Go-green.svg?style=flat-square)](https://imlil.dev/pricing)
[![Concurrency: Unlimited](https://img.shields.io/badge/Staffing-Unlimited-blue.svg?style=flat-square)](https://imlil.dev/docs)

---

**imlil.dev is the first High-Velocity AI Firm that lives in your terminal.**

Forget "coding assistants." You need a **team**.
**imlil** gives you a **CTO, Engineering Managers, Scrum Masters, Senior Devs, and QA Leads**—all working in parallel.

**10 Agents? 100 Agents? 1,000 Agents?**
There is no limit. If you have the tokens, we have the staff.
Build a full-stack SaaS (Backend + Frontend + Infra) in **60 seconds flat**.

---

## 👥 Meet Your New Employees

When you run `imlil make`, you are hiring a specialized, autonomous workforce:

### 1. **The Supervisor (CTO)**
*   **Role:** Architect & Planner.
*   **Job:** Designs the system, selects the stack (e.g., Next.js, Rust, Python), and maps out the entire project structure.
*   **Output:** A master architectural plan.

### 2. **The Operator (Engineering Manager)**
*   **Role:** Task Orchestrator.
*   **Job:** Breaks the CTO's plan into hundreds of parallel tickets. Assigns them to the worker pool.

### 3. **The Scrum Master (Agile Coach)**
*   **Role:** Flow Optimizer.
*   **Job:** Unblocks agents, manages retries, and ensures velocity remains high.

### 4. **The Coder (Senior Developer)**
*   **Role:** Implementation Specialist.
*   **Job:** Writes clean, idiomatic code.
*   **Superpower:** **Surgical Precision.** Unlike other tools that overwrite files blindly, The Coder reads your codebase's structure and inserts changes without breaking existing logic.

### 5. **The Validator (QA Lead)**
*   **Role:** The Gatekeeper.
*   **Job:** Enforces **Strict TDD**.
    1.  Writes a failing test.
    2.  Verifies the failure.
    3.  Approves the Coder's work *only* if the test passes.

---

## ⚡ Why Hire This Team?

### 1. **Unlimited Parallel Concurrency**
Why wait for one developer? **imlil** spawns an army.
*   **Scale:** Run **50+ agents** simultaneously.
*   **Speed:** Build a full-stack SaaS in minutes, not weeks.
*   **Infrastructure:** True multi-threaded execution for maximum throughput.

### 2. **Bleeding-Edge Intelligence (EmbedAPI)**
Your team uses the absolute latest research models, updated automatically.

**Currently Supported (2026):**
*   ⚡ **Gemini 3 Flash** (The fastest inference engine on the market)
*   🧠 **Gemini 3 Pro** (Unmatched reasoning and context)
*   🤖 **Claude 4.6 (Opus/Sonnet)** (Best-in-class coding & agentic behavior)
*   🚀 **GPT-5.3-Codex** (The new gold standard for software engineering)

### 3. **Context-Aware Memory**
Your team never forgets. They map your entire project's DNA before writing a single line of code, ensuring every file fits the architecture perfectly.

---

## 📦 Installation

```bash
npm install -g imlil
```

## 🔑 Setup

1.  **Get your Universal API Key:**
    Sign up at [https://imlil.dev](https://imlil.dev).
    > **⚠️ Note:** There is **no free plan**. This is enterprise-grade tooling.

2.  **Authenticate:**
    ```bash
    export EMBED_API_KEY="your-key-here"
    ```

---

## 🛠️ Usage

### The `make` Command
Issue a contract to your new digital firm.

```bash
# Contract: Build a SaaS Dashboard with 20 staff members
imlil make "A modern SaaS dashboard with Next.js 14, Tailwind, Supabase, and Stripe integration" --max-agents 20
```

### Options
*   `--max-agents <number>`: Staffing level. Default `10`. Increase for speed, decrease for cost efficiency.
*   `--debug`: Audit the internal Slack channels (logs) of your agents.

---

## 💻 Development

### Scripts

*   `npm test`: Runs the test suite.
*   `npm run lint`: Lints the codebase.

---

## 💎 Pricing: Pay-As-You-Go

**imlil** operates on a transparent, usage-based model via **EmbedAPI**.

*   **No Salaries:** You don't pay fixed monthly costs.
*   **Token-Based:** Pay only for the compute (tokens) your team consumes.
*   **Direct Pass-Through:** We provide the infrastructure; you provide the fuel.

*Check [imlil.dev/pricing](https://imlil.dev/pricing) for current rates.*

---

## 🏗️ The Org Chart

```mermaid
graph TD;
    Client[User] -->|Goal| Supervisor[Supervisor (CTO)];
    Supervisor -->|Plan| Operator[Operator (Manager)];
    Operator -->|Tasks| Backlog[Task Queue];
    
    subgraph Swarm [The Worker Pool]
        Scrum[Scrum Master] -->|Assigns| Coder[Coder];
        Coder -->|Code| Validator[QA Lead];
        Validator -->|TDD Check| Coder;
        Validator -->|Pass| Done[Done];
    end
    
    Backlog --> Scrum;
```

---

## 📜 License

Copyright © 2026 **imlil.dev**. All rights reserved.
Released under the MIT License.

> *"You define the product. We build the company that builds it."*
