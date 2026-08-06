/**
 * Minimal CESR stream parsing — enough to re-package a KEL served by a
 * KERIA OOBI endpoint (`GET …/oobi/<AID>`) into individual (event,
 * attachment) pairs for the CESR HTTP ingest (`POST …/` with
 * `CESR-ATTACHMENT` + `CESR-DESTINATION` headers).
 *
 * Used to PUSH key state to another agent instead of relying on the
 * recipient to pull our OOBI later (Andrew Weaver incident: the pull never
 * happened and the registration sat in escrow for 4 months; the manual
 * rescue was exactly this push, done with curl).
 */

export interface CesrMessage {
  /** Parsed event body (ked). */
  event: Record<string, any>;
  /** The exact serialized event bytes as a string. */
  eventRaw: string;
  /** CESR attachment text (signatures etc.) trailing the event. */
  attachment: string;
}

/** KEL message types worth pushing (establishment + interaction events). */
const KEL_ILKS = new Set(['icp', 'rot', 'ixn', 'dip', 'drt']);

const VERSION_RE = /^\{"v":"(?:KERI|ACDC)10JSON([0-9a-f]{6})_"/;

/**
 * Split a CESR stream into events and their trailing attachments. Each event
 * is a JSON object whose version string declares its own byte length; the
 * attachment is everything between the end of one event and the start of the
 * next. Malformed/truncated tails are dropped rather than throwing.
 */
export function parseCesrStream(stream: string): CesrMessage[] {
  const bytes = new TextEncoder().encode(stream);
  const decoder = new TextDecoder();
  const messages: CesrMessage[] = [];
  let pos = 0;

  while (pos < bytes.length) {
    // Find the start of the next JSON event
    while (pos < bytes.length && bytes[pos] !== 0x7b /* '{' */) pos++;
    if (pos >= bytes.length) break;

    const head = decoder.decode(bytes.slice(pos, pos + 32));
    const match = VERSION_RE.exec(head);
    if (!match) {
      pos++;
      continue;
    }
    const size = parseInt(match[1]!, 16);
    if (pos + size > bytes.length) break; // truncated event — stop

    const eventRaw = decoder.decode(bytes.slice(pos, pos + size));
    let event: Record<string, any>;
    try {
      event = JSON.parse(eventRaw);
    } catch {
      pos += size;
      continue;
    }

    // Attachment runs until the next event start (or end of stream)
    let end = pos + size;
    while (end < bytes.length) {
      if (bytes[end] === 0x7b) {
        const nextHead = decoder.decode(bytes.slice(end, end + 32));
        if (VERSION_RE.test(nextHead)) break;
      }
      end++;
    }
    const attachment = decoder.decode(bytes.slice(pos + size, end));

    messages.push({ event, eventRaw, attachment });
    pos = end;
  }

  return messages;
}

/** Keep only KEL events (icp/rot/ixn/dip/drt) — drops rpy/exn/ACDC noise. */
export function filterKelMessages(messages: CesrMessage[]): CesrMessage[] {
  return messages.filter((m) => KEL_ILKS.has(m.event.t as string));
}

/**
 * Merge two KEL sources for a push, deduplicating by event SAID (`d`).
 * `primary` wins on conflicts — pass the OOBI-stream copy there, because its
 * attachments carry witness receipts an agent's /events clone can lack for
 * events another group member created (a receipt-less rot pushed to a
 * recipient sticks in their partial-witness escrow). `extra` supplies fresh
 * tail events the primary source hasn't synced yet.
 */
export function mergeKelMessages(primary: CesrMessage[], extra: CesrMessage[]): CesrMessage[] {
  const seen = new Set(primary.map((m) => m.event.d as string));
  const merged = [...primary];
  for (const msg of extra) {
    if (!seen.has(msg.event.d as string)) {
      seen.add(msg.event.d as string);
      merged.push(msg);
    }
  }
  return merged;
}
