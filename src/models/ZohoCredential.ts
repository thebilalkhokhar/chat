import { Schema, Connection, Model } from "mongoose";

/**
 * A rep's Zoho OAuth grant, written by the exhibition app when they sign in.
 *
 * This service only ever reads `refreshToken` and writes back a freshened
 * `accessToken`. The collection belongs to the exhibition app; the schema here
 * is deliberately a subset, describing just enough to use it.
 *
 * The tokens are stored in plain text. Anything that reads this collection is
 * handling credentials that grant CRM access as a named employee — treat the
 * values as secrets, never log them, and never send them anywhere but Zoho.
 */
export interface IZohoCredential {
  zohoUserId: string;
  email: string;
  fullName: string;
  accessToken: string;
  refreshToken: string;
  createdAt: Date;
  updatedAt: Date;
}

const ZohoCredentialSchema = new Schema<IZohoCredential>(
  {
    zohoUserId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    fullName: { type: String, default: "" },
    accessToken: { type: String, default: "" },
    refreshToken: { type: String, default: "" },
  },
  { timestamps: true, collection: "zohocredentials" }
);

export function zohoCredentialModel(connection: Connection): Model<IZohoCredential> {
  return (
    (connection.models.ZohoCredential as Model<IZohoCredential>) ||
    connection.model<IZohoCredential>("ZohoCredential", ZohoCredentialSchema)
  );
}
