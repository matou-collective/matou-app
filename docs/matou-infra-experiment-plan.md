# Matou Infrastructure Experiment Plan
### Recovery Flow — Local & Cloud

**Purpose:** Understand what happens to Matou members when infrastructure goes down, and how cleanly everything recovers. Run locally first to learn the behaviour safely, then repeat on the real cloud infrastructure to validate.

**The two systems under test:**
- **KERI stack** — handles identity. Members use this to join the org, sign things, issue credentials. Components: KERIA (the agent), witnesses (receipt-providers), schema server, config server.
- **AnySync stack** — handles documents. Members use this to create, edit, and sync content. Components: three sync nodes, coordinator, consensus node, file node, database (MongoDB), cache (Redis), object storage (MinIO).

These two systems are mostly independent, which means some failures will be partial — a member might still be able to edit documents while KERI is down, or vice versa. A key goal of these experiments is to map exactly where those lines are.

---

## Before You Start

### One-time local setup

**GitHub Container Registry login (required before anything else):** The AnySync config generator pulls a base image from GitHub's container registry (ghcr.io), which requires authentication even for public images. You only need to do this once per machine.

1. Go to [github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)](https://github.com/settings/tokens/new) and create a token with just the `read:packages` scope. Copy it — you only see it once.
2. In your terminal, run `docker login ghcr.io` and enter your GitHub username and the token as the password.

Without this step, `make setup-test` will fail with a "403 Forbidden" error when trying to pull the image.

---

**AnySync** needs to generate cryptographic network identity before it can run for the first time. This is a one-time step — once done, you never need to repeat it unless you do a full clean.

```
cd matou-infrastructure/any-sync
make setup-test
```

This takes a few minutes and generates config files in `etc-test/` and data in `storage-test/`. After it completes, AnySync is ready.

**KERI** auto-generates its `.env.test` from `.env.example` the first time you run `make up-test` — no manual setup needed. If you ever need to regenerate it (e.g. after a git pull changes `.env.example`), run:

```
cd matou-infrastructure/keri
make regen-env ENV_FILE=.env.test
```

### Starting and stopping everything

All commands run from `matou-infrastructure/` (the root folder, not the `keri/` or `any-sync/` subfolders).

| What you want to do | Command |
|---|---|
| Start the full stack | `make up-test` |
| Stop the full stack | `make down-test` |
| Check if everything is healthy | `make health-test` |
| See which containers are running | `make status-test` |
| Wipe all test data and start fresh | `make clean-test` then `make up-test` |

### Stopping individual services (to simulate failures)

To simulate a failure of a specific component, stop its container directly. You need Docker's project name to target the right stack:

```bash
# --- KERI services (project: matou-keri-test) ---

# Stop just the witnesses
docker compose -p matou-keri-test stop witness-demo

# Restart the witnesses
docker compose -p matou-keri-test start witness-demo

# Stop just KERIA
docker compose -p matou-keri-test stop keria

# --- AnySync services (project: matou-anysync-test) ---

# Stop a single sync node
docker compose -p matou-anysync-test stop any-sync-node-2

# Stop the coordinator
docker compose -p matou-anysync-test stop any-sync-coordinator

# Stop MongoDB (coordinator loses its database)
docker compose -p matou-anysync-test stop mongo-1
```

To bring everything back up after individual stops, run `make up-test` from the root — it will restart anything that's stopped.

### The multisig POC: your KERI health oracle

The repo includes a 13-phase automated test script (`make test-multisig-test`) that exercises the full KERI identity lifecycle: booting two clients, creating a shared org identity, issuing credentials from it, adding a second member to the org, and having that member issue credentials too. All 13 phases currently pass.

This is the most reliable way to confirm KERI is actually working correctly — more reliable than just checking if the containers are running. **After any KERI recovery step, run this as your verification.** If all 13 pass, KERI is healthy; if any fail, something is still broken even if the health check looks green.

```bash
cd matou-infrastructure/keri
make test-multisig-test
```

---

## How to record results

For each experiment, fill in the three blanks:
- **Member experience during failure** — what does a member actually see in the app?
- **Recovery time** — roughly how long from restart until things work again?
- **Anything members need to do?** — do they need to refresh, re-login, or does it auto-recover?

---

## Experiment 1: Baseline

**Goal:** Confirm everything is working normally and document what "healthy" looks like before breaking anything.

**Steps:**
1. Start the full stack: `make up-test` from `matou-infrastructure/`
2. Run the health check: `make health-test`
3. Run the KERI POC to confirm identity flows work: `make test-multisig-test` from `matou-infrastructure/keri/`
4. Open the Matou app pointed at the test stack
5. Log in as a test member, open a document, make an edit, confirm it saves

**What to observe:**
- Health check shows all services green
- All 13 POC phases pass
- App loads without errors
- Document edits sync without delay

**Record:** How long does cold startup take from `make up-test` to fully healthy?

> **Startup time:** ___________
>
> **POC result (x/13 phases pass):** ___________

---

## Experiment 2: Full stack shutdown and recovery

**Goal:** Understand what members experience during a complete outage and how long recovery takes after restart.

**Steps:**
1. Start from a healthy baseline (Experiment 1 done)
2. Stop everything: `make down-test`
3. Try to use the Matou app — note what happens
4. Wait 2 minutes
5. Start everything back up: `make up-test`
6. Note when the app becomes usable again
7. Run the POC to confirm full recovery: `make test-multisig-test`

**What to observe during downtime:**
- Does the app show an error immediately or does it hang?
- Can members see previously loaded content, or does the screen go blank?
- Is there any indication to the member about what's wrong?

**What to observe during recovery:**
- Does the app auto-recover once services are back, or does the member need to refresh/re-login?
- Does previously created content still exist after restart? (data persistence)
- Does the POC pass all 13 phases after recovery?

> **Member experience during outage:** ___________
>
> **Recovery time (restart to usable):** ___________
>
> **Did members need to do anything?** ___________
>
> **Was any data lost?** ___________
>
> **POC result after recovery (x/13):** ___________

---

## Experiment 3: KERIA goes down (AnySync stays up)

**Goal:** Understand what members can and can't do when the identity system is unavailable but documents still work.

**Steps:**
1. Start from a healthy baseline
2. Stop only KERIA: `docker compose -p matou-keri-test stop keria`
3. Try to use the Matou app — specifically try to open a document, and also try any identity-related action (e.g. the member profile, org membership view)
4. Note what works and what breaks
5. Restart KERIA: `make keri-up-test` from `matou-infrastructure/`
6. Run the POC to confirm full recovery: `make test-multisig-test`

**What to observe:**
- Can members still open and edit existing documents?
- What breaks? (login, profile, joining org, credential-related features)
- Does the app surface a clear error for the broken parts, or does it just silently fail?
- After KERIA restarts, does everything auto-recover or does the member need to do something?

> **What still works:** ___________
>
> **What breaks:** ___________
>
> **Recovery behaviour:** ___________
>
> **POC result after recovery (x/13):** ___________

---

## Experiment 4: Witnesses go down (KERIA stays up)

**Goal:** Witnesses are the weakest link in the current setup — all 6 run in a single container. Understand what members experience when witnesses are unavailable.

**Context:** Witnesses are like independent notaries — they countersign entries in the identity history book. KERIA can still serve existing identities from memory while witnesses are down, but it cannot anchor new key events (new member joins, key rotations) without witness receipts. The multisig POC stress-tests exactly this: phases that involve creating or rotating identities should fail; phases that only read existing state may still pass.

**Steps:**
1. Start from a healthy baseline
2. Stop only the witness container: `docker compose -p matou-keri-test stop witness-demo`
3. Run the POC to see exactly which phases fail: `make test-multisig-test`
4. Try to use the Matou app — try a new member join flow, and try actions that only read existing identity
5. Note what works and what breaks
6. Restart witnesses: `docker compose -p matou-keri-test start witness-demo`
7. Run the POC again — do all 13 phases pass after recovery?

**What to observe:**
- Which of the 13 POC phases fail without witnesses, and which still pass?
- Do existing members with established identities retain full access?
- What specific flows fail in the app? (new member registration is the most likely)
- After witnesses restart, do all 13 POC phases recover?

> **POC result without witnesses (which phases fail?):** ___________
>
> **What still works in the app:** ___________
>
> **What breaks in the app:** ___________
>
> **POC result after witness recovery (x/13):** ___________

---

## Experiment 5: One AnySync sync node goes down

**Goal:** You have three sync nodes. Losing one should be survivable. Verify this.

**Steps:**
1. Start from a healthy baseline
2. Stop one sync node: `docker compose -p matou-anysync-test stop any-sync-node-2`
3. Use the Matou app — open documents, make edits, check that sync still works
4. Run the AnySync health check: `make health-test` from `matou-infrastructure/`
5. Restart the node: `docker compose -p matou-anysync-test start any-sync-node-2`
6. Confirm it rejoins the network and the health check goes green again

**What to observe:**
- Does document sync continue working with only two nodes?
- Does the health check flag the missing node?
- After the node restarts, does it catch up on changes that happened while it was down?

> **Document sync during failure:** ___________
>
> **Health check output:** ___________
>
> **Node catch-up after restart:** ___________

---

## Experiment 6: AnySync coordinator goes down

**Goal:** The coordinator handles space membership and routing. Its failure is more disruptive than a single sync node going down.

**Steps:**
1. Start from a healthy baseline
2. Stop the coordinator: `docker compose -p matou-anysync-test stop any-sync-coordinator`
3. Try to use the Matou app — open documents, try to create a new document or space
4. Note what works and what breaks
5. Restart the coordinator: `docker compose -p matou-anysync-test start any-sync-coordinator`
6. Observe recovery — does the coordinator rejoin cleanly without needing a full restart?

**What to observe:**
- Can members still edit documents in spaces they already have open?
- Does creating new documents or spaces fail?
- After restart, how long before things feel normal again?

> **What still works:** ___________
>
> **What breaks:** ___________
>
> **Recovery behaviour:** ___________

---

## Experiment 6b: Consensus node down during new member registration ✅ COMPLETED

**Goal:** Understand what happens when a new member tries to join the org while the AnySync consensus node is offline.

**Context:** The consensus node handles ACL (access control) operations — which includes adding someone to a space. Inviting a new member to the community space is an ACL change, so it goes through the consensus node. If that node is unavailable when the invite is triggered, the operation can't complete.

**Steps run:**
1. Turned off the consensus node
2. Had a new user submit a registration
3. Admin went through the full approval flow in the app

**What happened — admin side:**

The approval flow proceeded further than expected. Admin was able to:
- Receive the registration ✓
- Record attendance (issued attendance credential) ✓
- Endorse (issued endorsement credential) ✓
- Approve registration (issued membership credential) ✓

But during the final step — generating the community space invite — it threw a warning and stalled:

> `[AdminActions] Space Invitation deferred: TimeoutError: signal timed out`

The membership credential was still issued despite the space invite failing.

**What happened — new member side:**

| Step | Status |
|---|---|
| Confirmation from admin | ✓ visible |
| Attendance registered | ✓ visible |
| Endorsement | ✗ not visible |
| Membership approved | ✓ visible |
| Receiving space invite | ⏳ stuck — never resolves |

**What happened after turning the consensus node back on:**

The stuck "receiving space invite" step did **not** auto-recover. Even after the node was back up and time had passed, the member remained stuck on that step. The space invite was not retried.

**Summary of findings:**

The consensus node being down creates a **silent partial failure** in the registration flow. Most of the flow completes (credentials are issued), but the space invite — which requires the consensus node to process an ACL change — times out and gets "deferred." The deferral does not recover automatically when the node comes back up, leaving the member in a limbo state: their credentials exist, but they never receive access to the community space.

The endorsement credential also wasn't visible on the member side during the outage, though this may resolve separately once sync catches up.

**Open questions to investigate:**
- Is there a way to manually re-trigger the space invite for a member stuck in this state?
- Does the endorsement credential eventually appear after the consensus node recovers, or is it also permanently lost?
- Is the "deferred" space invite stored somewhere that could be retried, or is it dropped entirely?

**To stop/start the consensus node:**
```bash
# Stop
docker compose -p matou-anysync-test stop any-sync-consensusnode

# Start
docker compose -p matou-anysync-test start any-sync-consensusnode
```

---

## Experiment 7: Full stack recovery — correct restart order

**Goal:** Understand if the order in which services come back up matters, and whether any sequence causes problems.

**Context:** Some services depend on others being ready first. AnySync's coordinator needs MongoDB. KERIA depends on witnesses being available. The unified `make up-test` command is supposed to handle this automatically — this experiment verifies it actually does.

**Steps:**
1. Stop everything: `make down-test`
2. Start using the unified command: `make up-test`
3. Watch the startup sequence — does anything fail to start, retry, or take unusually long?
4. Check health: `make health-test`
5. Run the POC: `make test-multisig-test`
6. Try starting the stacks in the opposite order: `make keri-up-test` first, then `make anysync-up-test`
7. Note any differences

**What to observe:**
- Does `make up-test` handle startup order correctly every time?
- Are there any services that consistently fail on first start and need a moment to retry?
- Is there a preferred startup order you should document?

> **Unified startup result:** ___________
>
> **Any services that fail on first start?** ___________
>
> **POC result (x/13):** ___________
>
> **Preferred startup order:** ___________

---

## Experiment 8: Data persistence across clean restart

**Goal:** Confirm that all member data survives a full stop-and-start (not a wipe). This is the most important check for production confidence.

**Steps:**
1. Start from a healthy baseline
2. As a test member: create a document with specific content, make an edit, confirm it saved
3. Run the multisig POC and note the org identity prefix it created (printed in the Phase 5 output as `prefix=...`)
4. Stop everything: `make down-test`
5. Start everything back up: `make up-test`
6. Log back in as the same test member — does their session restore, or do they need to re-login?
7. Check that the document exists with the same content
8. Run the POC again — note whether it creates a fresh org or reuses the one from before

**What to observe:**
- Is the document content intact?
- Is the member's KERIA session intact (no need to re-register)?
- Does the AnySync data persist (documents, spaces)?
- Does the KERIA data persist (existing AIDs, credentials)?

> **Document data survived?** ___________
>
> **Member session survived (needed to re-login)?** ___________
>
> **KERIA identity data survived?** ___________
>
> **AnySync data survived?** ___________

---

## Observations to carry forward to the cloud phase

After completing the local experiments, note any surprises here before moving to the cloud. The cloud phase should repeat the same experiments, but on real infrastructure — the goal is to confirm behaviour holds under real network conditions and real latency.

**Surprises from local experiments:**
> ___________

**Things that worked better than expected:**
> ___________

**Things that need fixing before the cloud phase:**
> ___________

---

## Cloud phase: setup and differences

The cloud experiments follow the same sequence (Experiments 1–8 above), with these key differences:

**Use a test account, not a real member.** Create a dedicated test identity in the org for this purpose. Do not run failure experiments during peak usage hours.

**Commands on the cloud infrastructure** use `make up-prod` / `make down-prod` / `make health-prod` instead of the `-test` variants. Individual container operations use the production project names (`matou-keri` and `matou-anysync` instead of the `-test` names).

**The POC still works on prod** — run it with the dev network targets (`make test-multisig` from `keri/`) to point it at the production ports.

**Recovery times will differ.** Cloud has real network latency, real DNS propagation, and Traefik TLS termination in front of everything. Some things that recover instantly locally may take longer in production.

**Document any differences** between local and cloud behaviour — these point to environment-specific issues worth addressing.

---

## Quick reference: what each component does

| Component | System | What breaks when it goes down |
|---|---|---|
| KERIA | KERI | Identity operations — login may fail for new sessions; existing sessions may continue briefly |
| witness-demo | KERI | New key events can't be anchored — new member joins, key rotations, and org creation all fail |
| any-sync-node-1/2/3 | AnySync | Document sync — losing one of three is survivable; losing all blocks syncing |
| any-sync-coordinator | AnySync | Space membership and routing — new spaces can't be created; some sync operations may fail |
| any-sync-consensusnode | AnySync | Space ACL operations (invites, membership changes) — registration flow partially completes but space invite times out and gets stuck; does **not** auto-recover when node comes back up |
| any-sync-filenode | AnySync | File attachments — text content may still work; files can't upload/download |
| MongoDB | AnySync | Coordinator's database — coordinator stops working entirely |
| Redis | AnySync | Coordinator/filenode cache — performance degrades or operations fail |
| MinIO | AnySync | Object storage for files — same as filenode failure |

---

## Known issues to watch for (from the multisig POC)

The POC uncovered three places in the Matou app's `client.ts` that need fixes before certain flows will work correctly. These are not infrastructure issues — they're app code issues — but they're relevant because some experiment scenarios may trigger them:

- **Creating a new org** (`createGroupAID`) — uses `toad: 0, wits: []` which works for a 1-of-1 org today but blocks adding members later. Watch for this if you test new org creation.
- **Adding a member to the org** (`addMemberToGroup`) — missing the pre-rotation and key-state-sync steps that the POC proved are required.
- **A member joining the org** (`joinGroup`) — needs a fix for signing at the correct group-level key index.

If experiments involving new org creation or member-add fail, it may be the app code rather than the infrastructure. The POC passes all 13 phases, so the infrastructure itself is capable — the fixes just need to be ported from the POC into the app. See `MULTISIG-POC-FINDINGS.md` in `matou-infrastructure/keri/` for the full details.
