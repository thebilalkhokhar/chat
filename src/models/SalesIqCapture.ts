import { Schema, Connection, Model } from "mongoose";

/**
 * A raw request SalesIQ sent to the bot webhook, stored verbatim.
 *
 * Zoho publishes the handler names and the shape of the reply, but not the
 * request body, the headers it arrives with, or how long it will wait for an
 * answer. Guessing any of those and building on the guess is how an integration
 * ends up wrong in a way nobody notices until a customer is mid-conversation,
 * so the first thing the webhook does is write down exactly what it was sent.
 *
 * Deliberately schema-less in `body` and `headers`: the whole point is to see
 * fields we did not anticipate. Anything typed here would quietly drop them.
 *
 * Short-lived. These hold whatever a visitor typed, so they expire on their own
 * rather than accumulating a transcript store nobody remembers agreeing to.
 */

export interface ISalesIqCapture {
  receivedAt: Date;
  method: string;
  path: string;
  /** Request headers, with anything credential-bearing already redacted. */
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  /** `handler` if the payload named one, so captures can be told apart at a glance. */
  handler: string;
  /** What we replied, and how long we took — the timeout budget is unknown. */
  reply: unknown;
  tookMs: number;
  /** Whether SalesIQ's RSA signature checked out against the configured key. */
  verified: boolean;
  /** The header the signature arrived in, and the algorithm that matched it. */
  signatureHeader: string;
  /** Why verification failed, when it did. */
  verificationDetail: string;
  /**
   * The body exactly as it arrived, before parsing.
   *
   * A signature is over these bytes, and re-serialising the parsed object would
   * reorder keys and change spacing — so without the original text a failed
   * verification cannot be diagnosed after the fact, only guessed at again.
   */
  rawBody: string;
  createdAt: Date;
  updatedAt: Date;
}

const SalesIqCaptureSchema = new Schema<ISalesIqCapture>(
  {
    receivedAt: { type: Date, default: Date.now },
    method: { type: String, default: "" },
    path: { type: String, default: "" },
    headers: { type: Schema.Types.Mixed, default: {} },
    query: { type: Schema.Types.Mixed, default: {} },
    body: { type: Schema.Types.Mixed },
    handler: { type: String, default: "", index: true },
    reply: { type: Schema.Types.Mixed },
    tookMs: { type: Number, default: 0 },
    verified: { type: Boolean, default: false },
    signatureHeader: { type: String, default: "" },
    verificationDetail: { type: String, default: "" },
    rawBody: { type: String, default: "" },
  },
  { timestamps: true, collection: "salesiq_captures" }
);

/**
 * Thirty days is long enough to finish the integration and short enough that an
 * abandoned capture endpoint does not become a permanent store of chat text.
 *
 * This is also the index the capture listing sorts on, so the field carries no
 * separate `index: true` — declaring both makes Mongoose build two.
 */
SalesIqCaptureSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export function salesIqCaptureModel(connection: Connection): Model<ISalesIqCapture> {
  return (
    (connection.models.SalesIqCapture as Model<ISalesIqCapture>) ||
    connection.model<ISalesIqCapture>("SalesIqCapture", SalesIqCaptureSchema)
  );
}
