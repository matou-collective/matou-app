# Context

## Ready tasks

!`bash .sandcastle/claim-next-task.sh`

The list above holds **at most one issue: the ticket this iteration has
already claimed** for you (multi-host pool — other hosts are working other
tickets concurrently; the claim means no one else will touch this one). It is
drawn priority-first from the `ready-for-agent` + dependencies-closed queue,
so it is already the most urgent claimable item. It is the sole source of
truth for what work exists. Do not run your own unfiltered query to find more
issues — if the list is empty, there is nothing claimable right now.

## Recent sandcastle commits (last 10)

!`git log --oneline --grep="sandcastle:" -10`

# Task

{{ENRICH:task-intro}}

To see a task in full:

    curl -sf -H "Authorization: token $(cat /run/secrets/forgejo_token)" "$FORGEJO_API/issues/<NUMBER>"

## Read first

{{ENRICH:read-first}}

## Rules

{{ENRICH:rules}}

## Workflow

{{ENRICH:workflow-verify}}

{{LANDING_RULES}}

## When you are blocked

{{HANDOFF_RULES}}

# Done

When all listed tasks are complete (or you are blocked on all remaining ones),
or the ready-tasks block at the top of this prompt is empty, you are a
candidate for completion. The list at the top was expanded when your iteration
**started** and may be stale — a task may have unblocked since. To decide
whether to signal completion, re-run:

    bash .sandcastle/list-ready-tasks.sh

This is a COMPLETION TEST, never a work order. It only LISTS — it does not
claim, and NOTHING it prints is yours to work. The single ticket you may work
is the one claim-next-task.sh already claimed for you (the ready-tasks block at
the top of this prompt); no other ticket carries this run's `swarm-claim`, and
the commit-msg gate will refuse a commit for one that does not.

So: if the re-run returns an empty array (or only tasks you are blocked on),
output the completion signal. If it returns anything else, a task has unblocked
— do NOT pick it up here. End the iteration normally; the NEXT iteration claims
it through claim-next-task.sh.

<promise>COMPLETE</promise>
