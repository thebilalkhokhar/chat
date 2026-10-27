import mongoose, { Connection } from "mongoose";
import { config } from "../config/env";

/**
 * Two databases on one cluster.
 *
 * `leads` is this service's own workspace plus the exhibition app's data: the
 * captured leads and the reps' Zoho grants. `connector` is the Zoho connector's
 * database, which already holds every email synced from the org's mailboxes —
 * that is where a customer's reply is read from, so nothing here polls Zoho
 * Mail itself.
 *
 * The connector database is opened read-only by convention: this service is a
 * guest there and must never write to another system's collections.
 */

let leadsConnection: Connection | null = null;
let connectorConnection: Connection | null = null;

/** Same credentials, different database on the same cluster. */
function uriFor(database: string): string {
  const uri = config.mongoUri;
  const [beforeQuery, query] = uri.split("?");
  const withoutTrailingSlash = beforeQuery.replace(/\/[^/]*$/, "");
  return `${withoutTrailingSlash}/${database}${query ? `?${query}` : ""}`;
}

export async function connectLeadsDb(): Promise<Connection> {
  if (leadsConnection) return leadsConnection;

  leadsConnection = await mongoose
    .createConnection(uriFor(config.leadsDb), { serverSelectionTimeoutMS: 15000 })
    .asPromise();

  console.log(`[db] connected to ${config.leadsDb}`);
  return leadsConnection;
}

export async function connectConnectorDb(): Promise<Connection> {
  if (connectorConnection) return connectorConnection;

  connectorConnection = await mongoose
    .createConnection(uriFor(config.connectorDb), { serverSelectionTimeoutMS: 15000 })
    .asPromise();

  console.log(`[db] connected to ${config.connectorDb} (read-only)`);
  return connectorConnection;
}

export async function closeConnections(): Promise<void> {
  await Promise.allSettled([leadsConnection?.close(), connectorConnection?.close()]);
  leadsConnection = null;
  connectorConnection = null;
}
