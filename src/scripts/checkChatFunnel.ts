import { connectLeadsDb, connectConnectorDb, closeConnections } from "../db/connections";
import { chatFunnel, chatFunnelList } from "../services/chatFunnel";

/**
 * Prints the funnel for a date range, as the dashboard's Chat funnel tab would
 * show it, without signing in.
 *
 *   npm run funnel -- 2026-09-01 2026-09-30 [all|chat|form] [rep@print247.us]
 *
 * The first run for a range asks the ERP about every chat and form lead with an
 * email or phone and stores the answers; later runs reuse them for a few hours.
 */
async function main() {
  const [from, to, type = "all", rep] = process.argv.slice(2);
  const leadsDb = await connectLeadsDb();
  const connectorDb = await connectConnectorDb();
  try {
    const started = Date.now();
    const funnel = await chatFunnel(leadsDb, connectorDb, { from, to, rep, type });
    console.log(`\n  ${funnel.from} to ${funnel.to} · ${funnel.type} leads · rep ${funnel.rep} · ${Date.now() - started}ms`);
    if (funnel.lookupError) console.log(`  ! ${funnel.lookupError}`);
    console.log(`  leads: ${funnel.leadKinds.chat} from chats, ${funnel.leadKinds.form} from forms`);
    for (const stage of funnel.stages) console.log(`  ${stage.label.padEnd(26)} ${String(stage.count).padStart(7)}`);
    console.log(`\n  new customers who paid: ${funnel.newCustomers}, $${funnel.newRevenue.toLocaleString()}`);

    console.log("\n  source                    chat leads  form leads  quoted  paid  revenue");
    for (const s of funnel.sources) {
      console.log(
        `  ${s.label.padEnd(25)} ${String(s.chatLeads).padStart(10)} ${String(s.formLeads).padStart(11)} ${String(s.quoted).padStart(7)} ${String(s.paid).padStart(5)}  $${s.revenue.toLocaleString()}`
      );
    }

    const list = await chatFunnelList(leadsDb, connectorDb, { from, to, rep, type, stage: "paid" });
    console.log(`\n  paid: ${list.total} lead(s), page ${list.page} of ${list.pages}`);
    for (const lead of list.chats.slice(0, 5)) {
      const o = lead.outcome;
      console.log(
        `  ${new Date(lead.createdAt).toISOString().slice(0, 10)}  ${lead.kind.padEnd(4)} ${lead.source.padEnd(9)} ${lead.repName.padEnd(16)} ` +
          `${o?.isNewCustomer ? "new" : "existing"} · quotes ${o?.quotes.count} · orders ${o?.orders.count} · payments ${o?.payments.count} ($${Math.round(o?.payments.amount ?? 0)})`
      );
    }
  } finally {
    await closeConnections();
  }
}

main().catch((error) => {
  console.error("funnel failed:", error.message);
  process.exit(1);
});
