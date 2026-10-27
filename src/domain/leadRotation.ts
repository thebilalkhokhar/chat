/**
 * Who owns the next CRM lead.
 *
 * The team's rotation, written out the way they wrote it:
 *
 *   Round 1: Frank -> Brian -> Harry
 *   Round 2: Frank -> Brian
 *   Round 3: Frank -> Brian
 *   Round 4: Frank -> Brian
 *   Round 5: Frank -> Brian -> Harry
 *   ...and repeat
 *
 * Twelve leads to a full cycle: five to Frank, five to Brian, two to Harry.
 * Harry's two are deliberately at the ends of the cycle rather than spread
 * through it, which is why this is kept as rounds and not as a ratio — a
 * weighting that merely came out 5:5:2 would put his in different places.
 *
 * Kept apart from the chat rotation on purpose. `repPool` is who the bot speaks
 * AS and `liveAgentEmails` is who a live chat is offered TO; neither decides who
 * owns the record afterwards. Jessica takes chats and never owns a lead, which
 * is only expressible because the three lists are separate.
 */

/** Indices into the agent list: 0 = Frank, 1 = Brian, 2 = Harry. */
const ROUNDS: number[][] = [
  [0, 1, 2],
  [0, 1],
  [0, 1],
  [0, 1],
  [0, 1, 2],
];

/** The cycle, flattened — twelve positions before it repeats. */
export const ROTATION: number[] = ROUNDS.reduce((all, round) => all.concat(round), []);

export const CYCLE_LENGTH = ROTATION.length;

/**
 * The agent whose turn it is at a given position in the sequence.
 *
 * Position counts leads actually created, so it survives restarts and is shared
 * by every process: it lives in the settings document and is incremented in the
 * same operation that reads it.
 */
export function ownerIndexAt(position: number, agentCount = 3): number {
  // The rounds above were written for three people. Any other list — six since
  // October: Frank, Harry, Jessica, Paul, Ethan, Brian — is one each, in order.
  if (agentCount !== 3) {
    const count = Math.max(1, agentCount);
    return ((Math.trunc(position) % count) + count) % count;
  }
  const at = ((Math.trunc(position) % CYCLE_LENGTH) + CYCLE_LENGTH) % CYCLE_LENGTH;
  return ROTATION[at];
}

/**
 * The order to try, starting with whoever's turn it is.
 *
 * Not just the one name, because an agent who cannot own a record in the CRM —
 * no Zoho sign-in on file — would otherwise take the lead nowhere. The caller
 * walks this list and uses the first who can, so a missing sign-in costs that
 * agent their turn instead of costing us the lead.
 */
export function ownersToTry(position: number, agents: string[]): string[] {
  const list = agents.map((email) => String(email || "").trim()).filter(Boolean);
  if (!list.length) return [];

  const start = ownerIndexAt(position, list.length);
  const order: string[] = [];

  for (let step = 0; step < list.length; step += 1) {
    const agent = list[(start + step) % list.length];
    if (agent && !order.includes(agent)) order.push(agent);
  }

  return order;
}

/** The whole cycle as names, for proving the sequence and for the dashboard. */
/**
 * Who gets the next lead, with take-overs counted.
 *
 * Each rep has a balance: +1 for every lead they got by taking a chat over
 * (it counts as their turn, so the rotation passes them once), -1 for every
 * rotation lead they lost to a rep who took the chat over (they are owed one).
 *
 * - Anybody owed goes first, without moving the rotation on.
 * - Otherwise the rotation runs from `position`, passing over a rep with a
 *   positive balance (spending one of it) or with no way to own a lead.
 *
 * `turns` is how far the rotation moved: 0 when an owed lead was paid back,
 * otherwise 1 plus every rep passed over.
 */
export function pickWithBalances(
  position: number,
  agents: string[],
  balances: Record<string, number>,
  canOwn: (email: string) => boolean
): { email: string | null; turns: number; spent: string[]; repaid: string | null } {
  const order = ownersToTry(position, agents);
  const owed = order.find((email) => (balances[email.toLowerCase()] || 0) < 0 && canOwn(email));
  if (owed) return { email: owed, turns: 0, spent: [], repaid: owed };

  const spent: string[] = [];
  for (let step = 0; step < order.length; step += 1) {
    const email = order[step];
    if (!canOwn(email)) continue;
    if ((balances[email.toLowerCase()] || 0) > 0 && !spent.includes(email)) {
      spent.push(email);
      continue;
    }
    return { email, turns: step + 1, spent, repaid: null };
  }
  // Everybody able to own a lead is ahead on take-overs: the first of them takes it.
  const fallback = order.find(canOwn) || null;
  return { email: fallback, turns: fallback ? order.indexOf(fallback) + 1 : 1, spent: spent.filter((e) => e !== fallback), repaid: null };
}

export function cycleFor(agents: string[]): string[] {
  return ROTATION.map((index) => agents[index] || `(no agent ${index + 1})`);
}
