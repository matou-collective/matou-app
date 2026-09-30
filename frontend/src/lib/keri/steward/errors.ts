/**
 * Refusals a steward sees instead of an org act that would be wrong: a KEL
 * fork, an issuance from the wrong identity, or a registry this agent cannot
 * issue into. `userMessage` is shown as-is; `message` carries the detail.
 */
export class StewardRefusal extends Error {
  constructor(message: string, readonly userMessage: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class GroupBehind extends StewardRefusal {
  constructor(detail: string) {
    super(`group KEL behind the witnesses: ${detail}`, "Your copy of the community's history is behind — try again in a moment.");
  }
}
export class GroupDiverged extends StewardRefusal {
  constructor(detail: string) {
    super(`group KEL ahead of every witness: ${detail}`, "Your copy of the community's history has events the community's witnesses don't — contact the other stewards before acting.");
  }
}
export class NotJoined extends StewardRefusal {
  constructor(detail: string) {
    super(`not joined to the org group: ${detail}`, "You're still being set up as a steward — finish joining before approving.");
  }
}
export class RegistryNotAdopted extends StewardRefusal {
  constructor(detail: string) {
    super(`org registry not adopted: ${detail}`, "Your wallet can't issue into the community's registry yet — try again in a moment.");
  }
}
export class ReplayFailed extends StewardRefusal {
  constructor(detail: string) {
    super(`replay failed: ${detail}`, "A change another steward made couldn't be applied to your wallet yet.");
  }
}

/**
 * Our member key is not (yet) one of the group's current signing keys — e.g.
 * the promoter rotated its personal AID and the group rotation has not landed.
 * Retryable and quiet: nothing is posted, the act stays pending.
 */
export class NotSignerYet extends StewardRefusal {
  constructor(detail: string) {
    super(`not a current group signer: ${detail}`, "Waiting for the community's key rotation to finish.");
  }
}

/** What to show a user for a failed steward act: a refusal's plain words, else the error text. */
export function userFacingMessage(err: unknown): string {
  if (err instanceof StewardRefusal) return err.userMessage;
  return err instanceof Error ? err.message : String(err);
}
