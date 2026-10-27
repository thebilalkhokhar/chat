/**
 * What SalesIQ actually sent, most recent first.
 *
 * The answer to the two questions phase one exists to settle: what the request
 * body really looks like, and how long we are taking to answer it.
 *
 *   npx ts-node --transpile-only src/scripts/salesiqCaptures.ts [count]
 */
import { connectLeadsDb, closeConnections } from "../db/connections";
import { salesIqCaptureModel } from "../models/SalesIqCapture";

async function main() {
  const limit = Number(process.argv[2]) || 10;
  const leadsDb = await connectLeadsDb();

  const captures = await salesIqCaptureModel(leadsDb)
    .find({})
    .sort({ receivedAt: -1 })
    .limit(limit)
    .lean();

  if (captures.length === 0) {
    console.log("Nothing captured yet.");
    console.log("The Zobot has not called the webhook, or it could not authenticate.");
    console.log("Railway logs show rejected calls as: [salesiq] rejected an unauthorised request");
    await closeConnections();
    return;
  }

  console.log(`${captures.length} capture(s), newest first\n`);

  for (const capture of captures) {
    console.log("=".repeat(72));
    console.log(`${capture.receivedAt.toISOString()}  ${capture.method} ${capture.path}`);
    console.log(`handler: ${capture.handler || "(not named in the payload)"}   answered in ${capture.tookMs}ms`);
    console.log(
      capture.verified
        ? `signature: VERIFIED via ${capture.signatureHeader}`
        : `signature: not verified — ${capture.verificationDetail || "unknown"}`
    );

    console.log("\nheaders:");
    for (const [key, value] of Object.entries(capture.headers || {})) {
      console.log(`  ${key}: ${String(value)}`);
    }

    console.log("\nbody:");
    console.log(indent(JSON.stringify(capture.body, null, 2) || "(empty)"));
    console.log("\nwe replied:");
    console.log(indent(JSON.stringify(capture.reply, null, 2)));
    console.log();
  }

  // The number that decides whether a model call can happen inside the request.
  const times = captures.map((c) => c.tookMs);
  console.log("=".repeat(72));
  console.log(`response time: min ${Math.min(...times)}ms, max ${Math.max(...times)}ms`);
  console.log("handlers seen:", [...new Set(captures.map((c) => c.handler || "(none)"))].join(", "));

  // The two answers phase one is after, stated plainly.
  const verified = captures.filter((c) => c.verified);
  if (verified.length > 0) {
    console.log(`signature header: ${verified[0].signatureHeader}  (${verified.length}/${captures.length} verified)`);
  } else {
    console.log("signature header: NOT YET IDENTIFIED — check the headers above for a signature-looking value");
  }

  await closeConnections();
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
