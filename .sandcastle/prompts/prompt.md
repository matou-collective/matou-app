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

## When you are blocked

{{HANDOFF_RULES}}

# Done

When all listed tasks are complete (or you are blocked on all remaining ones),
or the ready-tasks block at the top of this prompt is empty, you are a
candidate for completion. The list at the top was expanded when your iteration
**started** and may be stale — a task may have unblocked since. So first
re-run:

    bash .sandcastle/list-ready-tasks.sh

Only if it returns an empty array (or only tasks you are blocked on) output
the completion signal; otherwise end the iteration normally and the next
iteration will pick the fresh task up.

<promise>COMPLETE</promise>
