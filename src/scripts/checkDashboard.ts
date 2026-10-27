/**
 * Parses the dashboard's inline script before it can be deployed.
 *
 * The whole page is one `<script>` block, so a single stray quote takes every
 * function down with it — including the login form. Nothing looks broken: the
 * page renders, the fields are there, and pressing Sign in simply does nothing.
 * That happened, and it took a live outage to notice, because a syntax error in
 * a browser is invisible from the server.
 *
 * Runs as part of `npm run build`, so a broken page cannot reach a deployment.
 */
import fs from "fs";
import path from "path";

const PAGE = path.join(__dirname, "..", "server", "public", "index.html");

function main() {
  const html = fs.readFileSync(PAGE, "utf8");

  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) {
    console.error("dashboard: no <script> block found in index.html");
    process.exit(1);
  }

  const source = match[1];

  try {
    // Compiled, never called: this is a syntax check, not an execution.
    new Function(source);
  } catch (error: any) {
    console.error(`\n  dashboard JavaScript is broken: ${error.message}`);
    console.error("  The page would render but nothing on it would work, login included.\n");
    process.exit(1);
  }

  // The handlers the page cannot function without.
  const required = ["function doLogin", "function api(", "function save(", "function render("];
  const missing = required.filter((name) => !source.includes(name));

  if (missing.length > 0) {
    console.error(`\n  dashboard is missing: ${missing.join(", ")}\n`);
    process.exit(1);
  }

  console.log(`  dashboard: script parses (${source.length} chars)`);
}

main();
