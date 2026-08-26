/**
 * Recipient selection for issue #63's group-KEL propagation push.
 *
 * A kt=1 multisig group AID can be used by more than one signing member to
 * anchor group `ixn`s (a registry `vcp`, a credential `iss`). With kt=1 no
 * co-sign round runs, so nothing propagates one member's group ixn to the
 * OTHER members' agents — the `/multisig/rot` rotation-signal only covers
 * rotations. The next member to issue then re-anchors at the same sequence
 * number the first member already used, forking the group KEL; agents that
 * saw the first event treat the second as duplicitous and the credential
 * never validates for its recipient.
 *
 * To close that window, the acting member proactively pushes the freshly
 * advanced group KEL to every OTHER signing member's agent after anchoring.
 * This helper picks those recipients from the org's known signing-member AID
 * list (the org config `admins`).
 *
 * Returns the deduped set of member AIDs to push to: the given members minus
 * the group AID itself, the currently-acting member, and any empty entries.
 */
export function selectGroupKelPushTargets(
  memberAids: readonly (string | null | undefined)[],
  groupAidPrefix: string,
  actingMemberAid?: string | null,
): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const aid of memberAids) {
    if (!aid) continue;
    if (aid === groupAidPrefix) continue;
    if (actingMemberAid && aid === actingMemberAid) continue;
    if (seen.has(aid)) continue;
    seen.add(aid);
    targets.push(aid);
  }
  return targets;
}
