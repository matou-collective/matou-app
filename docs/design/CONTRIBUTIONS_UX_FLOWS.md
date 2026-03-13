# Matou Contributions System — UX Flows

**Version:** 1.0
**Date:** March 2026
**Source:** CONTRIBUTIONS_SYSTEM_PRODUCT_DESIGN.md

---

## Table of Contents

1. [Proposal Creation → Approval](#1-proposal-creation--approval)
2. [Project Setup → Implementation Planning](#2-project-setup--implementation-planning)
3. [Contribution Lifecycle](#3-contribution-lifecycle)
4. [Contribution Change](#4-contribution-change)
5. [Nested Contribution Creation](#5-nested-contribution-creation)
6. [Decision Plan Lifecycle](#6-decision-plan-lifecycle)

---

## 1. Proposal Creation → Approval

```
Actor: Community Member (Proposer)

1. Navigate to Proposals page
2. Click "+ New Proposal"
3. Fill out Create Proposal dialog → Submit
4. Proposal created in "Draft" status
5. From proposal detail, click "Submit for Endorsement"
   → Status changes to "Submitted"
6. From proposal detail, click "Copy Proposal Link"
   → Link copied to clipboard
   → Proposer pastes link in a chat channel
   → Other members clicking the link in chat see a proposal modal
     with proposal details and an "Endorse" action
   → No status change
7. Community members endorse the proposal
   → From the chat modal or from the proposal detail page
   → They click "Endorse Proposal"
   → Progress bar updates
8. Endorsement threshold met
   → Status auto-transitions to "In Review"

System

9. System creates two contribution requests:
   → "Proposal Lead" contribution
   → "Proposal Steward" contribution
   → These are listed on the proposal detail page
     in an "Assigned Roles" section visible only to admins
   → Notification and email sent to all community admins:
     "Proposal '[title]' has met endorsement threshold.
      Proposal Lead and Steward contributions are available
      for assignment."

Actor: Admin / Operations Steward

10. Admin assigns Proposal Lead and Steward
    (from the contribution requests on the proposal detail page)

Actor: Proposal Lead

11. Proposal Lead reviews proposal
    → Both Proposal Lead and original Proposer can edit the proposal
    → All edits are tracked in proposal history
    → Any member can click "View History" on the proposal detail
      to see a changelog of all modifications
12. Proposal Lead makes a decision:
    → Approve: Signs off → Status changes to "Signed Off"
    → Decline: Declines proposal → Status changes to "Rejected"
      with reason provided
13. Proposal Lead creates Decision Plan
    (from proposal detail → "Create Decision Plan")
14. Fills out governance actions for each house
    → Each action has a type: "meeting" or "decision"
    → Meeting actions include date, time, location/link
    → Decision actions specify the vote parameters
15. Submits plan for review

Actor: Proposal Steward

16. Proposal Steward reviews and signs off plan

Actor: All Members (Governance Participation)

17. Members can view all governance actions on the decision plan
    → Each action is clickable and opens a governance action modal
    → If action type is "meeting":
      - Modal shows meeting details (date, time, location/link)
      - "Attend" button visible only if meeting is not yet completed
      - Clicking "Attend" sends a calendar invite via email
    → If action type is "decision":
      - Modal shows vote interface
      - Voting is disabled until the corresponding meeting for
        that house has been marked as completed
      - Once meeting is completed, members can cast their vote

Actor: Governance Houses
(Each house vote depends on its governance actions
 from the decision plan being completed)

18. Elder Council: meeting completed → veto decision enabled
    → Records outcome (No Veto / Veto)
19. Community House: meeting completed → strategic vote enabled
    → Records outcome (Approved / Rejected)
20. Contributor House: meeting completed → operational vote enabled
    → Records outcome (Approved / Rejected)
21. All approved → Proposal status "Approved"
    → System prompts: Create new project or link existing
```

---

## 2. Project Setup → Implementation Planning

```
Actor: Admin / Operations Steward

1. Proposal approved → System shows project creation prompt
   OR: Navigate to Projects → "+ New Project"
2. Create Project dialog
   → Link to proposal(s)
   → Assign project steward and lead
3. Navigate to project detail page

Actor: Project Lead

4. In project detail → "Implementation Plans" tab
5. Click "+ Create Implementation Plan"
6. Fill out plan details (title, budget, lead, steward)
7. Within plan detail, click "+ Add Milestone"
   → Create milestones with titles and durations
8. Within each milestone, click "+ Add Contribution"
   → Create contributions (see Flow 3)
9. Click "Submit for Sign-off"

Actor: Project Steward

10. Review implementation plan
11. Click "Sign Off Plan"
    → Plan marked as signed off
    → Contributions within it can be marked as "Confirmed"
```

---

## 3. Contribution Lifecycle

```
Actor: Project Lead / Operations Steward

1. Create contribution (from project, milestone, or contributions page)
   → Fill out Create Contribution dialog
   → Contribution in "Created" status
2. Review contribution → Click "Confirm"
   → Status changes to "Confirmed"
3. Contribution opens for interest registration (48h window)

Actor: Contributors

4. Browse open contributions on Contributions page
   → Filter by "Confirmed" status
5. Click "Register Interest" on a contribution
   → Fill out interest form
6. Wait for assignment notification

Actor: Project Lead

7. View interested contributors on contribution detail
8. Select contributor → Click "Assign Contributor"
   → Status changes to "Assigned"
   → Contributor receives notification

Actor: Assigned Contributor

9. Work on contribution
10. (Optional) Create nested sub-contributions
    → Click "+ Add Sub-task" within contribution detail
11. Complete work
12. Fill out Evidence & Completion section:
    → Completion notes
    → How acceptance criteria were met
    → Upload evidence files or add URLs
    → Report actual hours
    → Upload time report
13. Click "Submit for Review"
    → Status changes to "Needs Review"

Actor: Project Lead

14. Review submission on contribution detail page
15. In Review section:
    → Select outcome: Approve / Incomplete / Decline
    → Set quality rating (1-10)
    → Enter review comments
    → Confirm approved resources
16. Click "Submit Review"
    → If Approved: status → "Approved"
    → If Incomplete: status → "Assigned" (contributor reworks)
    → If Declined: status → "Archived"

Actor: Project Steward / Operations Steward

17. Review approved contribution
18. Click "Sign Off Contribution"
    → Status changes to "Signed Off"
    → Treasury action generated (future: reward distribution)

System

19. (Future) Distribute rewards
    → Status changes to "Rewarded"
20. (Future) Archive
    → Status changes to "Archived"
```

---

## 4. Contribution Change

```
Actor: Assigned Contributor or Project Lead

1. On contribution detail page (status: "Assigned")
2. Click "Change Contribution"
3. Change Contribution dialog opens
   → Warning about re-confirmation requirement
   → Edit fields that need changing
   → Provide reason for change
4. Submit change
   → Status changes to "Changed"
   → Immediately transitions to "Confirmed" (requires re-confirmation)

Actor: Project Lead / Steward

5. Re-confirm the contribution
   → Status returns to "Confirmed"
6. Re-assign if needed
   → Follow normal assignment flow
```

---

## 5. Nested Contribution Creation

```
Actor: Assigned Contributor

1. On contribution detail page for their assigned contribution
2. Click "+ Add Sub-task" in Nested Contributions section
3. Create Contribution dialog opens
   → Parent contribution pre-filled (read-only)
   → Project pre-filled from parent
   → Milestone pre-filled from parent
4. Fill out sub-contribution details
5. Submit → Sub-contribution created in "Created" status

Actor: Project Lead

6. Confirm sub-contribution
7. Assign contributor (may be same as parent)
8. Sub-contribution follows normal lifecycle

Note: Parent contribution cannot be signed off until
all nested contributions are in "Signed Off" status.
```

---

## 6. Decision Plan Lifecycle

```
Actor: Proposal Lead

1. From proposal detail (status: "In Review" or "Signed Off")
2. Click "Create Decision Plan"
3. Fill out decision plan form:
   → Title, description
   → Objectives and expected outcomes
   → Assign proposal lead and steward
   → Add governance actions for each house
4. Submit → Plan in "Drafted" status

Actor: Proposal Lead

5. Click "Submit for Review"
   → Status changes to "Submitted"

Actor: Proposal Steward

6. Review decision plan
7. If changes needed → provide feedback (plan returns to "Drafted")
8. If satisfactory → Click "Sign Off"
   → Status changes to "Signed Off"
   → Proposal can proceed to voting process

Actor: Proposal Lead (during voting)

9. For each governance action:
   → Facilitate the discussion/meeting/vote in the relevant house
   → Record outcome via "Record Outcome" dialog
   → Enter vote data if applicable
10. Once all actions have outcomes recorded:
    → System evaluates results
    → Proposal transitions to "Approved" or "Rejected"
```
