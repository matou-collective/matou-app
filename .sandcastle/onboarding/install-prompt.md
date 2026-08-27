# The install session — a bare repo and its machines, to a running consumer

You are a Claude session running from a checkout of the factory core on the
machine the human works at, with the human who owns the repo present. Your
job is one sitting: take a repo that has never been onboarded and the
enrolled machine(s) that will carry it, and leave behind a factory consumer
that claims tickets, runs its gate, and closes them.

Every mechanical step already exists as an `onboarding/onboard.sh`
subcommand — in this checkout for the repo half, in each machine's own
factory checkout for the host half. This document is the layer above them:
the ORDER, the questions that are genuinely the human's, and the proof at
the end. You drive the subcommands; you never re-implement what one of them
does.

Read this whole file before you run anything. Then work the nine steps in
order.

---

## How this session is started

From the human's own factory checkout, wherever they work — not on a fleet
machine:

```sh
cd <factory-checkout>
claude "Follow onboarding/install-prompt.md and onboard <owner/repo> onto
        the fleet. Its local checkout is at <local-checkout>."
```

**Interactive, launched locally; the host half runs over ssh.** The session
splits along the line the tooling already draws. The **repo half** —
detect, vendor, identity, the policy interview, labels, workflows,
dockerfile, prompts — is host-independent: it runs where you are standing
and ends in a push to the target repo. The **host half** — host preflight,
credential files, enrolment, the runner, the claim probe — executes on each
machine the human chooses, through its ssh door. Nothing in the host half
trusts where the session stands: every host fact is the printed output of a
probe, and the probes report the same facts over a door as they would at a
local prompt. What the launch machine needs: this factory checkout, a
checkout of the target repo, and a working door to every chosen machine.

If you are reading this from a consumer's own `.sandcastle/onboarding/`
copy, you are reading the contract at that consumer's pin — useful for
knowing what its setup promised. The subcommands themselves live in a
factory checkout: the harness a consumer vendors deliberately does not carry
the tooling that edits a host's crontab or registers a runner.

## What you are allowed to decide

Everything in this session that is **revertible by a commit or a config
edit, and provable by something you can run**, you decide yourself and
record. That is the same standing every worker in this factory holds, and it
is what makes an install a sitting rather than a week of tickets.

When you decide something that a human might have expected to be asked
about — a stack the detector guessed, an e2e tier you inferred, a label you
kept — say so on the consumer's tracking issue in the form this factory
uses: **"Ruled by agent under the two-way-door doctrine — veto anytime"**,
with what proves it. The human vetoes by saying so; you re-run the step.
Nothing you do in this session costs more than a re-run, by construction.

Two standing rules for every step below:

- **Idempotent.** Every step can be re-run. If a step half-finished, run it
  again rather than patching its output by hand — a hand-patched artifact is
  the one thing the next pin bump silently destroys.
- **Prove, don't assume.** Each step below names what proves it. A step
  whose proof did not run is not done, and does not go in the report.

## The one-way doors — where you stop

These are not yours. Stop, name the exact residue, and let the human cross
them:

1. **Credential bytes.** You prepare the shape and probe the result; the
   human puts the value in place. See step 7 — a credential's bytes never
   pass through this conversation.
2. **Org or team grants.** Adding the repo to an organisation, granting a
   token an org-wide scope, adding a bot to a channel: fleet-visible, and
   not undone by a revert.
3. **Runner registration on a machine that has none.** The registration
   token is a credential and the registration is fleet-visible; you hand
   over the recipe, and the human runs it in their own terminal, supplying
   the token to exactly that one invocation.
4. **Anything that widens a security posture or destroys data** — a
   rootless-to-rootful docker cutover, wiping a checkout, force-pushing a
   branch. Name the wall precisely; a human crosses it.

Stopping at one of these does not end the session: finish every step that
does not depend on it, and list what is left in the report.

## Before you start: the four facts

Ask for these up front, in one question, and repeat them back:

1. **`<owner/repo>`** — the target repo's slug on its forge.
2. **`<local-checkout>`** — where that repo is checked out on THIS machine.
   Clone it if it is not here yet.
3. **The machine(s) that will carry it** — one or more enrolled machines,
   each named by its ssh door (the form is `<user>@<host>`; the human knows
   theirs). The fleet's machine list is deliberately host-resident and never
   committed (ADR 0005), so this question has no file to fall back on: the
   human answers it, and "both" is a normal answer — the host half below is
   a loop over doors. For each chosen machine, also collect, from the human
   or over its door:
   - its registry `<registry>` (the default is
     `$HOME/swarm/host-registry.conf` on that machine). If the machine has
     never been enrolled, the schema and a worked example are in
     `onboarding/templates/host-registry.conf.example`; the declaration is
     written WITH the human in step 8, not now;
   - its factory checkout `<factory-on-host>` — an enrolled machine has
     one; its crontab names it;
   - `<workdir>` — where THIS repo's checkout lives (or will live) on that
     machine.
4. **The factory ref to pin** — default: the factory's current `origin/main`.
   A repo joining the fleet should start at the same pin the rest of it runs.

Export the two tracker variables once, here, so every later step inherits
them (the token comes from the launch machine's own token file or env — you
never type one):

```sh
export FORGEJO_API="https://<forge-host>/api/v1/repos/<owner/repo>"
export FORGEJO_TOKEN="$(cat <token-file>)"   # or already in your env
```

Then open (or ask the human for) **one tracking issue** in the target repo's
tracker, titled `factory onboarding — <owner/repo>`. Every ruling you make
in this session goes there as a comment, and the final `SETUP_REPORT` goes
there too. One issue, so the install has a single audit trail.

---

## 1 — Preflight: what is true about the repo and the machines

First, prove every door: `ssh <door> true` for each chosen machine. A door
that does not open is a stop — every host-half proof below depends on it,
and a session that continues past a dead door is proving things about the
wrong fleet.

Then print both preflights, whole, before you change anything. Neither
writes. The first runs here; the second runs once per chosen machine, over
its door:

```sh
bash onboarding/onboard.sh detect <local-checkout>
ssh <door> "bash <factory-on-host>/onboarding/onboard.sh onboard-host preflight <registry>"
```

`detect` prints one `KEY=value` line per repo fact — the slug it derived
from `origin`, the stacks, the package manager and its pin, the default
branch, whether a `.sandcastle` is already there and at what ref, whether
the labels are minted, and a suggested e2e tier. Warnings go to stderr;
"unknown" is a value, not a failure. Carry these values into steps 2, 5 and
the interview: they are the answers you do NOT need to ask a human for.

`onboard-host preflight` names everything wrong with that machine in one
pass — docker mode, the toolchain, disk headroom, the uid alignment every
image build there must use, a checkout and a warm package store per served
repo, and log egress.

**Stop and ask if:**

- the repo has **no forge remote** (`DETECT_SLUG` empty) — nothing
  downstream has a tracker to talk to, and guessing a slug is how a session
  mints labels in the wrong repo;
- preflight reports **no docker**, or a **rootless** daemon, on any chosen
  machine — the rootless subuid wall is the known enrolment killer, and
  crossing it is a one-way door (see above);
- preflight reports **no runner** on a machine that is meant to run CI for
  this repo — registration is step 8, and needs the human.

Everything else preflight says is a note you carry, not a stop.

Re-run: both, any time. They only read.

## 2 — Vendor: pin the harness

```sh
bash onboarding/onboard.sh vendor <local-checkout>/.sandcastle <ref>
```

Create the `.sandcastle` directory first if it does not exist. `<ref>` is
the ref the human named; a branch or tag is resolved and the resulting
commit sha is what gets recorded, so the pin is always a sha.

Vendor reads the file set from the manifest **at that pinned ref** (never
from the checkout you are standing in), writes it as the target's
`FACTORY_MANIFEST` beside `FACTORY_REF`, and proves itself by running the
freshly vendored `check-harness-drift.sh` and requiring its `OK` line. If
you do not see that line, the vendor did not succeed — do not continue.

Re-run: safe. A re-vendor at the same ref is a no-op. A re-vendor at a NEW
ref refuses if a vendored file was edited locally since the old pin, listing
each one — that refusal is a feature: land the fix in the factory, bump the
pin, re-vendor. `--force` overwrites and lists what it overwrote; only reach
for it once the human has read the list.

**Proof:** `check-harness-drift: OK`.

## 3 — Identity: the thin per-repo layer

```sh
bash onboarding/onboard.sh identity <owner/repo> \
     <local-checkout>/.sandcastle/swarm-identity.sh
```

This writes the repo's `FORGEJO_API`, its `HEAL_WORKDIR`, its `REPO_SLUG`
and its `RUNNER_HOST`. Two of those are facts only the human can confirm:

- **`RUNNER_HOST`** — the machine `session-runner.sh` and `heal.sh` run on.
  With more than one machine chosen, this names exactly ONE of them — ask
  the human which. It is named in the rendered prompts, so getting it wrong
  sends a future session to the wrong machine. There is deliberately no
  cross-repo default.
- **`HEAL_WORKDIR`** — where the healer's own checkout of this repo lives
  on `RUNNER_HOST`. The generated default may not be where it actually is;
  check it against the `<workdir>` you collected for that machine and
  against the registry declaration written in step 8, and edit the file if
  they disagree.

Read the generated file back to the human, both lines, and confirm.

**Proof:** the file sources cleanly (`bash -n`), and the two values above
match what step 8 declares.

## 4 — Policy: the interview

This is the step that is genuinely a conversation. Everything else in this
session is a consequence of what gets decided here. The knobs are a closed
set; ask them in this order, and record the answer AND the reason.

```sh
bash onboarding/onboard.sh policy \
     <local-checkout>/.sandcastle/swarm-policy.sh --interactive \
     LANDING=<push|pr> MERGE_AUTHORITY=<human|agent-after-green> \
     SESSION_RUNNER=<on|off> TWO_WAY_DOOR_DOC=<path>
```

`--interactive` asks the hand-off label set and mints anything the tracker
lacks, so it needs `FORGEJO_API` and `FORGEJO_TOKEN` in the environment
(exported in "Before you start"). Its answers win over any hand-off set you
pass on the command line — a value there only seeds the questions.

**LANDING** — `push` (a worker rebases and pushes to the default branch) or
`pr` (a worker opens a branch and a pull request). Ask it as the question it
really is: *"when a worker finishes a ticket, should the change be on the
main branch, or waiting for someone?"* A repo with a live product surface
and reviewers usually wants `pr`; a harness or a tooling repo usually wants
`push`.

**MERGE_AUTHORITY** — only meaningful under `pr`. `human` means somebody
merges; `agent-after-green` means the agent merges once the gate is green.
Ask whether the repo's CI gate is actually trusted to be the last word. If
the human hesitates, take `human` — it is the reversible answer.

**SESSION_RUNNER** — `on` by default for every factory repo; that is a
standing ruling, not a preference. Ask only as a confirmation, and take an
opt-out only with a reason worth writing down. This is the permanent,
per-repo decision, and it is NOT the same thing as the host's kill switch
(which pauses a machine temporarily).

**The hand-off labels (`HUMAN_LABELS`)** — this is the loop-in state
machine, and it is per-repo by ruling: how finely a repo wants to be looped
in lives in the definition and use of these labels. The interview walks the
current set (keep / rename / drop, each with its trigger), then takes
additions until a blank name. Each label maps to exactly ONE trigger from a
fixed vocabulary:

- `one-way-door` — irreversible, or not provable by a test the agent can
  run, so it is not the agent's to rule.
- `cannot-proceed` — a hard blocker hit mid-run that cannot be worked
  around.
- `missing-context` — a spec, a dependency answer or a fixture is absent, so
  the slice is not yet implementable.
- `product-decision` — a product or scope call that belongs to the product
  owner.

The defaults are `ready-for-human:one-way-door`,
`agent-blocked:cannot-proceed` and `needs-info:missing-context`. A repo with
a product owner distinct from its maintainers almost always wants a fourth
carrying `product-decision`. Explain the consequence before asking: each
label becomes exactly one bullet in this repo's rendered prompt (step 6), so
adding one is cheap and dropping one leaves a blocked worker with nowhere to
park a ticket. The interview refuses an empty set for that reason.

**PROTECTED_PATHS** — the directories a worker may not edit. Leave it unset
unless the repo has a second directory with the same "vendored, do not touch
by hand" property as the harness itself; the default already covers the
harness and the workflows.

**TWO_WAY_DOOR_DOC** — this repo's OWN decision record stating its
two-way-door doctrine, as a path relative to its checkout root. A harness
prompt STRING hands this pointer to an agent, so a wrong path is a 404 in
every future triage. If the repo keeps no such record, leave it unset: the
prompt then says so in words, which is honest. If the human wants one, write
it in this session — it is a page, and it is what every later ruling cites.

**The e2e tier — mandatory, asked here, written now:**

```sh
bash onboarding/onboard.sh e2e-tier <local-checkout>/.sandcastle/E2E_TIER \
     <journey|smoke|opt-out> "<reason, required for opt-out>"
```

`detect` suggests a tier from the repo's layout; the human confirms it. A
repo may opt out — a harness repo with no product surface legitimately does
— but the reason is recorded, because the point of the question is that a
gap is DECLARED rather than silent. The subcommand refuses an unreasoned
opt-out.

Re-run: the policy write validates structure (known keys, enums, the trigger
vocabulary) and refuses rather than writing a file that would explode when
sourced. Re-run it after any change of mind; then re-run step 6's render,
because the hand-off section of the prompt is GENERATED from this file.

**Proof:** the written policy file, read back to the human line by line, and
`E2E_TIER` with its tier and reason.

## 5 — The mechanical fan-out

Four subcommands, no questions the earlier steps have not already answered.
Run them in any order.

```sh
bash onboarding/onboard.sh labels     <owner/repo> <core|core+design>
bash onboarding/onboard.sh workflows  <local-checkout>/.forgejo/workflows \
                                      <pool-label> <e2e-host-label>
bash onboarding/onboard.sh dockerfile <local-checkout>/.sandcastle/Dockerfile \
                                      <stack>
bash onboarding/onboard.sh secrets    <owner/repo> \
                                      <local-checkout>/docs/SECRETS_CHECKLIST.md
```

- **labels** — mints the core set, skipping any that exist. Take
  `core+design` only if this repo is adopting the design-to-agent pipeline;
  otherwise `core`. Note that step 4's interview has already minted any
  hand-off label the tracker lacked.
- **workflows** — the two arguments are **runner labels**, and they come
  from the host registry, not from a guess: the first is the pool label the
  swarm's jobs schedule onto, the second is the pinned host label the e2e
  smoke job needs. Read them out of each chosen machine's registry over its
  door (`ssh <door> "cat <registry>"`) and repeat them back. With more than
  one machine, the pool label is the one the machines share, and the pinned
  label names the ONE machine that carries the repo's product stack. On a
  machine that has never been enrolled there is no registry to read yet:
  decide the labels with the human NOW, matching the declaration step 8
  will write — the schema in
  `onboarding/templates/host-registry.conf.example` names them. A repo
  that opted out of e2e does not need the smoke workflow; a repo that
  already has its own CI keeps it — do not overwrite a `ci.yml` that exists
  without asking, and remember the build+test line in the generated one is a
  placeholder only the human can fill.
- **dockerfile** — the stack comes from `detect`'s `DETECT_STACKS` (it is
  emitted in exactly the joinable form this subcommand accepts) and the
  package-manager pin from `DETECT_PKG_MANAGER`. If detect said the stack is
  none, the generated file still carries the harness layer, which is
  correct: the stack layer is marked and the human fills it.
- **secrets** — writes the checklist the human works from in step 7.
  Nothing here reads or writes a credential.

**Then author what `vendor` deliberately did NOT deliver.** The identity
layer is a consumer's own by construction, so a freshly vendored
`.sandcastle/` has no ignore file, no env example and no secrets readme —
and the harness's container entry point has no package manifest to be run
from. This is the residue that otherwise gets discovered days later, one
broken worker at a time:

- **`.sandcastle/.gitignore`** — write it here, BEFORE step 7 puts anything
  sensitive on disk on the machines: each machine's `<workdir>` is a
  checkout of this repo, and this file is what keeps a pasted secret out of
  every future diff there. The shape every consumer needs:

  ```
  .env
  logs/
  worktrees/
  secrets/*
  !secrets/README.md
  pnpm-store/
  nix-store/
  __pycache__/
  ```

- **`.sandcastle/secrets/README.md`** — the one file under `secrets/` that
  is committed (the rule above un-ignores it by name): what each token file
  is and which script consumes it. The checklist you just generated is its
  source.
- **`.sandcastle/.env.example`** — the live `.env` is host state: step 7
  creates it on each machine, and it never exists in this checkout. What
  the identity layer commits is the template, if this repo wants one — a
  repo whose swarm runs under CI needs one, because the run refreshes the
  machine's `.env` from it every run. Its keys come from that same
  checklist, values blank.
- **a package manifest at the repo root** — the harness's container entry
  point is a TypeScript file that a node package manager runs, so a repo
  with no manifest cannot start a worker. A repo that has one gains the
  sandcastle runner in it; a repo that has none gets a minimal private
  manifest carrying only that. `detect`'s `DETECT_PKG_MANAGER` tells you
  which manager and which pin this repo already uses — match it, and commit
  the lockfile it produces.

Re-run: labels skip what exists; the other three overwrite their out-file.
If the human has hand-edited a generated workflow or Dockerfile, say so
before you overwrite it.

**Proof:** `detect` again — `DETECT_LABELS` should now read as minted — plus
the generated files, and the four authored above, listed to the human.

## 6 — Prompts: the judgement-heavy step

The five prompt skeletons in the factory are generic. What a repo's workers
actually read is those skeletons rendered through this repo's identity, its
policy, and a set of **enrichment files this repo must author**. This is the
one step in the session where the words matter more than the mechanics, and
it is worth taking your time over: these files become live instructions for
every future worker in this repo.

Create `<local-checkout>/.sandcastle/prompt-enrichments/` and write one
file per slot, WITH the human. The render refuses, naming the file, if one
is missing — so the refusal is your checklist:

| Slot | What it carries |
| --- | --- |
| `task-intro.md` | what this repo IS, in the two sentences a worker needs before its first ticket |
| `read-first.md` | the files a worker must read before touching anything here |
| `rules.md` | this repo's own working rules — its doctrine, its review bar, what it refuses |
| `workflow-verify.md` | what "green" means here: the exact commands that prove a change |
| `ops-context.md` | how this repo runs in anger — its jobs, its hosts, its logs |
| `classify.md` | how the healer classifies a failure in this repo |
| `repairs.md` | the repairs the healer is allowed to make unattended |
| `session-rules-heading.md` | the heading naming THIS repo's two-way-door record (one whole line) |
| `rehearsal-drive-intro.md` | which drive the reporter diagnoses, what it is made of, its known-red frontier (one whole paragraph) |
| `rehearsal-heal-intro.md` | the same drive from the HEALER's side: its evidence files, its box, what a targeted check is in this toolchain |

Guidance that saves a re-write:

- **A slot is spliced verbatim.** It is never re-templated, so write final
  prose, not a template — and do not reuse one slot's text in another, even
  when two slots describe the same thing. The reporter's paragraph and the
  healer's paragraph are deliberately separate: handing the healer the
  reporter's text gives it a second, contradicting role sentence and points
  it at a box it is forbidden to touch.
- **The last three slots own their whole line or paragraph**, not a phrase
  inside it. That is why they can carry a repo's own record path and its own
  drive facts without the skeleton naming any.
- **A repo that stands up no rehearsal drive says exactly that**, in the
  paragraph. "There is no drive here" is a complete and correct enrichment.
- **Name only paths that resolve in THIS repo.** A path inherited from
  another repo's prompt is a 404 for every worker that reads it, and there
  is a test in the vendored suite that will catch it.
- Worked examples, both real and both readable from the factory checkout you
  are standing in: this factory's own consumer layer under
  `.sandcastle/prompt-enrichments/` (a harness repo with no product surface
  and no drive), and the reference set for `Matou/idss` under
  `onboarding/tests/fixtures/idss-prompts/` (a product repo with a live
  drive). The skeletons they fill are `prompts/prompt.md`,
  `prompts/heal-prompt.md`, `prompts/session-runner-prompt.md`,
  `prompts/rehearsal-report-prompt.md` and
  `prompts/rehearsal-heal-prompt.md` — read the skeleton beside the slot you
  are writing so you can see the sentence your text lands in.

Then render:

```sh
bash onboarding/onboard.sh render-prompts <local-checkout>/.sandcastle
```

It renders the five skeletons **at the target's pinned ref** through the
repo's own identity and enrichments, and generates the hand-off section from
step 4's policy. It refuses on an unfilled placeholder or a missing
enrichment, naming it. The five rendered files are committed by the
consumer: they are live text, inspectable bytes, never computed at run time.

Re-run: after ANY change to an enrichment, the identity or the policy.
Re-rendering is how a repo picks up a skeleton fix at a pin bump too.

**Proof:** `render-prompts` reports each of the five files written or
unchanged, and the human has read at least the rendered worker prompt end to
end.

## 7 — Land the repo half; credentials on each machine

The repo half is complete. Commit and push it before anything touches a
machine — the host half deploys by pulling what you pushed, never by
copying files sideways. The consumer layer is exactly the files the earlier
steps wrote:

```
.sandcastle/            (the vendored harness, FACTORY_REF, FACTORY_MANIFEST,
                         swarm-identity.sh, swarm-policy.sh, E2E_TIER,
                         Dockerfile, .gitignore, .env.example, secrets/README.md,
                         the five rendered prompts, the enrichments)
.forgejo/workflows/     (the rendered workflow set)
docs/SECRETS_CHECKLIST.md
<package manifest>      (and its lockfile, if step 5 wrote one)
```

Check the diff before you commit: `.sandcastle/.env` and
`.sandcastle/secrets/` (bar its readme) must NOT be in it. In this flow they
never exist in the local checkout at all — a live one appearing here means a
host-half step ran in the wrong place. Stop if either shows; a secret
committed once is a one-way door.

Then, on each chosen machine, bring `<workdir>` to that commit over its
door — clone it first if it does not exist there yet — and prove the pin
travelled:

```sh
ssh <door> "git -C <workdir> pull --ff-only"
ssh <door> "cd <workdir>/.sandcastle && bash check-harness-drift.sh"
```

If step 1's preflight called the package store cold for this repo, warm it
in `<workdir>` now, over its door, before the first worker hits it.

**Now the credentials. A credential's bytes
never pass through this conversation.** You do not ask the human to paste a
value into the session, you do not read one of this repo's credential
files, you do not echo one, and you do not put one on
a command line where it would land in the process table. And in this flow a
secret's home is the machine that runs the workers — so the bytes never
land on the launch machine either. You prepare the SHAPE over each door,
hand over exact recipes, and then prove the result by probing it.

Prepare the shape, per machine:

```sh
ssh <door> "mkdir -p <workdir>/.sandcastle/secrets && chmod 0700 <workdir>/.sandcastle/secrets"
ssh <door> "touch <workdir>/.sandcastle/.env && chmod 0600 <workdir>/.sandcastle/.env"
```

Then put the keys in that machine's `.env` — the NON-secret ones, and only
those the checklist from step 5 names (the committed `.env.example` is the
template). The harness has an allowlist guard that refuses any other
secret-shaped key in that file, so a key you were about to add and the
guard disagree about is a question, not a typo to work around.

Confirm `.sandcastle/.env` and `.sandcastle/secrets/` are both git-ignored
ON the machine — the workdir is a checkout, and the ignore file you wrote in
step 5 arrived with the pull. Prove it, per machine:

```sh
ssh <door> "git -C <workdir> check-ignore .sandcastle/.env .sandcastle/secrets"
```

If either is not ignored, fix that FIRST, commit the fix, and re-pull: a
secret committed once is a one-way door.

Then hand the human the recipes, and say plainly: **run these in your own
terminal, not through me.** Each connects to the machine itself and reads
the value from standard input, so the bytes never reach an argument, a
history file, this transcript, or the launch machine's disk:

```sh
ssh <door> 'install -m 0600 /dev/stdin <workdir>/.sandcastle/secrets/forgejo_token'
# ...paste the token, press Enter, then Ctrl-D
```

Repeat that line, unchanged but for the filename, for each file the
checklist from step 5 says this repo needs — and repeat the whole set once
per chosen machine: a secret is host state, so two machines means the same
paste twice, once per door. The one key that goes in `.sandcastle/.env`
instead of a file is the Claude token — the CLI has no file-based flag for
it — so tell the human to open that machine's `.env` in an editor over
their own ssh connection and edit that one line, leaving every other key
alone: every key there is forwarded into each worker container and is
readable by anyone with Docker API access, which is exactly why the other
tokens are files.

Then verify — per machine, as many times as it takes:

```sh
ssh <door> "bash <factory-on-host>/onboarding/onboard.sh verify-creds <workdir>/.sandcastle"
```

The probe executes on the machine, which is the point: liveness must hold
from where the workers will actually run, not from where you are sitting.
It prints one `PASS` / `FAIL` / `SKIP` line per credential and exits zero
only when nothing failed. It probes shape AND liveness: a tracker token must
authenticate and be able to WRITE AN ISSUE (a read-only token that fails at
the first close is the failure this probe exists to catch); a chat bot token
must authenticate and be a MEMBER of the channel (posting works without
membership, reading replies does not). The only bytes of any credential it
will ever print are the length. Read its output to the human verbatim — it
is safe to, by construction.

A `SKIP` is fine and means "not configured for this repo". A `FAIL` is the
loop: tell the human which file or key on which machine, and what the probe
said, and re-run. Do not proceed to step 9 with a `FAIL` outstanding — the
acceptance run cannot pass without a working tracker token.

Re-run: any time. The probe only reads.

**Proof:** the drift check's `OK` line and a `verify-creds` run with no
`FAIL` line, on every chosen machine.

## 8 — Host: make the repo scheduled

Onboarding a repo makes it *workable*; enrolling it on its machines is what
makes it *scheduled*. For each chosen machine, write (or extend) THAT
machine's registry declaration with the human — it is the input to
everything below, and it lives on the machine, never in a repo (the
registry is host-resident by ruling, ADR 0005 — which is why the four facts
asked the human for the doors instead of reading a committed list):

- a `repo` line naming the slug and its checkout (`<workdir>`);
- a `coverage` line — `pool` for the generic harness, `e2e` if this machine
  also carries the repo's own product stack (which needs that repo's own
  provisioning hook to exist, or enrolment fails loudly rather than
  downgrading in silence);
- a `backstop` line for the workflows this repo wants ticked, with windows;
- a `session` line **if and only if** step 4 left the session drainer on,
  and only on the machine `RUNNER_HOST` names, pointing at a DEDICATED
  checkout — never a tree the swarm resets mid-run;
- a `repo-env` line if this repo needs host-only variables of its own. Its
  own, not the shared file: a product's variable in the shared env silently
  reaches every other repo on that machine.

Then, per machine:

```sh
ssh <door> "bash <factory-on-host>/onboarding/onboard.sh onboard-host enrol <registry>"
ssh <door> "bash <factory-on-host>/onboarding/onboard.sh onboard-host verify <registry>"
```

`enrol` re-runs preflight and refuses to touch the machine if it fails,
backs the live crontab up before writing, splices ONE marker-delimited
block, and passes every line outside that block through byte-identical. It
fails closed if an unmanaged line already runs an entry point the block owns
— that is the double-scheduling guard; remove the old lines by hand first.
`verify` then reports what is actually installed and what the last tick
said.

If a machine has no runner yet, that is a one-way door: the registration
token is a credential, so the recipe below is the human's to run, in their
own terminal, pasting the token when `read` waits for it:

```sh
ssh -t <door> 'read -rs FORGEJO_RUNNER_TOKEN && export FORGEJO_RUNNER_TOKEN && bash <factory-on-host>/onboarding/onboard.sh onboard-host runner-register <registry>'
# ...paste the registration token, press Enter
```

It registers under the name and labels the registry declares — so a job's
`runs-on` and the fleet's idea of that machine cannot drift apart. It
leaves an already-registered runner strictly alone.

Finally, prove each machine can actually claim in THIS repo's tracker:

```sh
ssh <door> "bash <factory-on-host>/onboarding/onboard.sh onboard-host claim-probe <registry> <owner/repo>"
```

It opens a synthetic ticket, claims it, checks the claim names that
machine, and closes it again — including on failure, so it never litters a
tracker.

**More than one machine is a loop, not a fork:** run this whole step once
per door. A second machine enrolling for the same repo needs no
coordination with the first — the claim pool is multi-host-safe by
construction — so the probe passing on each machine independently is the
whole proof.

Re-run: `enrol` is idempotent (a second run leaves the crontab
byte-identical); `verify` and `claim-probe` only prove.

**Proof:** `verify` with no missing cron line and a green `claim-probe`, on
every chosen machine.

## 9 — Acceptance: one real ticket, end to end

Nothing above proves the repo WORKS. This step does, and it is the bar this
factory has used for every consumer it has onboarded. The consumer layer is
already pushed and on every machine (step 7); what is left is to watch the
machinery work.

File ONE smoke ticket in the target repo: something small, real, and
verifiable by the repo's own gate — a typo in a doc, a missing test case, a
README line. Label it `ready-for-agent` and watch it through:

1. **claim** — a worker claims it and the claim comment names one of the
   chosen machines;
2. **commit** — a commit lands carrying the change;
3. **gate** — the repo's own CI runs against it;
4. **close** — a close-report comment is posted and the ticket closes.

If it stalls, the diagnosis is almost always in the step that produced the
missing input: a claim that never happens is a schedule or a token; a run
that dies immediately is a cold package store or a uid mismatch; a close
that never comes is a token without issue-write. Go back to that step and
re-run it — every one of them is re-runnable, which is the whole reason the
install is shaped this way.

**The exit criterion is two things, both of them printed output:**

- `check-harness-drift.sh` prints its `OK` line in `<workdir>` on every
  chosen machine (step 7 proved it once; re-prove it now if anything was
  re-pulled since);
- the smoke ticket is closed by the machinery, not by you.

Then post the `SETUP_REPORT` below on the tracking issue.

---

## The SETUP_REPORT

One comment on the consumer's tracking issue, filled in — every line an
observed fact, never a plan:

```
SETUP_REPORT — <owner/repo>

pin              FACTORY_REF <sha>  (drift check: OK on every machine)
machines         <door> — registry <registry>; enrol + verify green;
                 claim-probe green; runner <registered / already present /
                 not needed>
                 (one such line per chosen machine)
identity         REPO_SLUG / HEAL_WORKDIR / RUNNER_HOST as committed
policy           LANDING=<> MERGE_AUTHORITY=<> SESSION_RUNNER=<>
                 hand-off labels: <label>:<trigger> ...
                 TWO_WAY_DOOR_DOC=<path or "unset, stated in words">
e2e              tier <> (<reason, if opt-out>)
labels           <n> minted / already present
workflows        <files written>
repo-owned files .sandcastle/.gitignore, .env.example, secrets/README.md,
                 the root package manifest: <written / already present>
credentials      verify-creds: <PASS/SKIP counts>, no FAIL, on every machine
prompts          five rendered; enrichment slots authored: <n>
acceptance       smoke ticket <owner/repo><issue ref>: claimed by <machine>,
                 committed <sha>, gate green, closed by the machinery

rulings made this session (each: what, and what proves it)
  - ...

left for a human (one-way doors, with the exact residue)
  - ...
```

If the "left for a human" list is empty, say so explicitly. If it is not,
the repo is still a consumer — it is a consumer with a named gap, which is a
completely different thing from an install that quietly stopped.

## If you cannot finish

Say exactly why, on the tracking issue, and leave the rest of the report
filled in for what DID land. Never report an install as done when the
acceptance run did not close a ticket: the next session reads this comment,
and a report that overstates what happened costs more than the install saved.

## Provenance

This document is the instruction layer of the agent-driven install-session
arc in `Matou/dev-factory` (issue 61); the boundary it draws — the mechanics
stay scripts, the interview and the orchestration are what an agent adds —
is recorded in `docs/adr/0006-*.md`, along with the launch-flow ruling that
put the session on the human's own machine with the host half over ssh.
Every subcommand it drives is documented
in `onboarding/README.md`, and `onboarding/tests/install-prompt-contract-test.sh`
fails the factory's own CI if this document ever names a subcommand, a policy
key or a hand-off trigger that the code does not have — or ever carries a
concrete ssh door, a paste recipe that lands bytes anywhere but the machine,
or a host-half invocation that does not go over a door.
