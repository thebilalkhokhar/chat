import type { Connection } from "mongoose";
import { zohoCredentialModel } from "../../models/ZohoCredential";
import { settingsModel, type ISettings } from "../../models/Settings";

/**
 * Choosing which rep a chat belongs to.
 *
 * The AI speaks as a named person and the CRM lead is created under them, so
 * this decision is made once when the chat opens and then never revisited — a
 * visitor who is greeted by one name and handed to another has been passed
 * around, which is exactly what talking to a named rep is meant to avoid.
 *
 * A rep is only eligible if they have a Zoho sign-in on file. Without one there
 * is no token to write the lead as them, so putting them in the rotation would
 * mean every chat that landed on them silently produced no CRM record. Better to
 * skip them and say so than to lose the enquiry.
 */

export interface ChosenRep {
  email: string;
  name: string;
  zohoUserId: string;
}

/**
 * Whether a rep may be given a chat — fresh or inherited.
 *
 * The pool was only ever consulted for a brand new visitor. A returning one
 * was handed straight back to whoever had them last, and a customer whose
 * email matched an earlier chat was moved to that chat's rep, so taking
 * somebody out of the pool stopped new faces reaching them and nothing else.
 * Anyone removed is now removed from those routes as well.
 */
export function inRotation(email: string | undefined, settings: ISettings): boolean {
  const who = String(email || "").trim().toLowerCase();
  if (!who) return false;
  return (settings.chat.repPool || []).some((member) => String(member).trim().toLowerCase() === who);
}

/**
 * The next rep in turn, so the work spreads evenly.
 *
 * A plain round-robin over the pool, not "whoever has had the fewest". Counting
 * chats went wrong twice. Counted over all time, Harry signed into Zoho with a
 * thousand chats to the others' five and a half thousand and took every new
 * chat to catch up. Counted over a rolling day, the same burst came back the
 * next day as an echo: his chats from yesterday aged out of the window at the
 * rate they had arrived, so he was always the one furthest behind. Any count
 * remembers the past; a turn does not.
 *
 * The position lives in the settings document and is taken and advanced in one
 * atomic update, so it survives restarts and two chats opening together get
 * different reps. A rep joining or leaving the pool just changes whose turn
 * comes next — nobody inherits a backlog.
 */
export async function pickRepForChat(
  leadsDb: Connection,
  settings: ISettings
): Promise<ChosenRep | null> {
  const pool = (settings.chat.repPool || [])
    .map((email) => String(email).trim().toLowerCase())
    .filter(Boolean);

  if (pool.length === 0) return null;

  const credentials = await zohoCredentialModel(leadsDb)
    .find(
      { email: { $in: pool }, refreshToken: { $nin: ["", null] } },
      { email: 1, fullName: 1, zohoUserId: 1 }
    )
    .lean();

  const eligible = credentials.map((credential) => ({
    email: String(credential.email).toLowerCase(),
    name: credential.fullName || "",
    zohoUserId: String(credential.zohoUserId),
  }));

  if (eligible.length === 0) return null;

  // Named rather than counted silently: a rep in the pool who never receives a
  // chat looks like a bug from the outside, and the reason is always the same.
  const skipped = pool.filter((email) => !eligible.some((rep) => rep.email === email));
  if (skipped.length) {
    console.warn(`[chat] not in rotation, no Zoho sign-in: ${skipped.join(", ")}`);
  }

  // In the pool's own order, so the turn goes round the list as the team wrote it
  // rather than in whatever order the database returned the sign-ins.
  eligible.sort((a, b) => pool.indexOf(a.email) - pool.indexOf(b.email));

  const taken = await settingsModel(leadsDb).findOneAndUpdate(
    { key: "singleton" },
    { $inc: { "chat.repPoolAt": 1 } },
    { new: true, projection: { "chat.repPoolAt": 1 } }
  );

  // The value after the increment, so the first chat takes position 0.
  const position = Number((taken as any)?.chat?.repPoolAt ?? 1) - 1;
  return eligible[((position % eligible.length) + eligible.length) % eligible.length];
}

/**
 * The rep already on a conversation, or a freshly chosen one.
 *
 * Existing chats keep whoever they started with even if the pool has changed
 * since — the visitor has been talking to that name.
 */
export async function repForConversation(
  leadsDb: Connection,
  conversation: { repEmail?: string; repName?: string },
  settings: ISettings
): Promise<ChosenRep | null> {
  if (conversation.repEmail) {
    const credential = await zohoCredentialModel(leadsDb)
      .findOne({ email: conversation.repEmail }, { email: 1, fullName: 1, zohoUserId: 1 })
      .lean();

    if (credential) {
      return {
        email: String(credential.email).toLowerCase(),
        name: credential.fullName || conversation.repName || "",
        zohoUserId: String(credential.zohoUserId),
      };
    }
  }

  return pickRepForChat(leadsDb, settings);
}
