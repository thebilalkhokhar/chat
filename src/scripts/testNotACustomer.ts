/**
 * Job seekers, against what the three of them actually typed.
 *
 * Chats bb52d4b5…-1, 049cf0fb…-0 and 5c89b241…-2, all off the same Google PMax
 * mylar-bags campaign in one afternoon. Two became Zoho leads because they had
 * left an email address, which was all the sweep checked.
 *
 * Runs on its own — no database, no model.
 */
import { isLookingForWork, chatIsAboutAJob } from "../domain/notACustomer";
import { isPlaceholderValue } from "../domain/quoteFields";

let bad = 0;

function check(name: string, got: unknown, expected: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}: ${JSON.stringify(got)}${ok ? "" : ` — wanted ${JSON.stringify(expected)}`}`);
}

console.log("-- what the three of them typed");
check(
  "retired, wants to keep busy",
  isLookingForWork("Looking for a work from home jobs. I'm over 60 and retired just need to keep busy."),
  true
);
check("home packing job, misspelt", isLookingForWork("Looking home paking job"), true);
check("the short one", isLookingForWork("Looking for a job"), true);
check("still saying it", isLookingForWork("You xant understand .im looking job"), true);
check("packing for a good company", isLookingForWork("Packing for a good company"), false);

console.log("");
console.log("-- other ways people ask");
check("are you hiring", isLookingForWork("are you hiring?"), true);
check("any vacancies", isLookingForWork("any vacancies"), true);
check("work from home", isLookingForWork("I want work from home"), true);
check("a cv", isLookingForWork("I would like to send my resume"), true);
check("employment", isLookingForWork("looking for employment"), true);

console.log("");
console.log("-- customers, who must never be turned away");
check("a job lot", isLookingForWork("I need a quote for a job lot of mylar bags"), false);
check("a rush job", isLookingForWork("this is a rush job, can you help"), false);
check("the job is the order", isLookingForWork("the job is 5000 pouches"), false);
check("wants boxes", isLookingForWork("looking for boxes"), false);
check("wants a quote", isLookingForWork("I need a quote for custom mylar bags"), false);
check("packaging for home business", isLookingForWork("I need packaging for my work from home business"), false);
check("nothing", isLookingForWork(""), false);

console.log("");
console.log("-- the whole chat, since the first message is the only one that says so");
check(
  "049cf0fb — job, then an email, then more job",
  chatIsAboutAJob(["Looking home paking job", "Galle128 @ymail .com", "Im looking job", "You xant understand .im looking job"]),
  true
);
check(
  "5c89b241 — job, then our own menu handed back",
  chatIsAboutAJob(["Looking for a job", "Both", "harlembaby383@gmail.com", "Any size"]),
  true
);
check(
  "bb52d4b5 — the one that never became a lead",
  chatIsAboutAJob(["Looking for a work from home jobs. I'm over 60 and retired just need to keep busy.", "Packing for a good company"]),
  true
);
check(
  "changed the subject to an actual order",
  chatIsAboutAJob(["are you hiring?", "actually, what would 5000 mylar bags cost"]),
  false
);
check("an ordinary enquiry", chatIsAboutAJob(["boxes", "6x6x6", "1000"]), false);
check("nothing said yet", chatIsAboutAJob([]), false);

console.log("");
console.log("-- our own words, recorded as their answer");
check("the menu, handed back", isPlaceholderValue("boxes, bags, or labels"), true);
check("the menu with a slash", isPlaceholderValue("boxes/bags/labels"), true);
check("the finish menu", isPlaceholderValue("matte, gloss or soft touch"), true);
check("any size", isPlaceholderValue("Any size"), true);
check("no preference", isPlaceholderValue("no preference"), true);
check("both", isPlaceholderValue("Both"), true);
check("doesn't matter", isPlaceholderValue("doesn't matter"), true);
// Real answers, which must survive.
check("one product", isPlaceholderValue("boxes"), false);
check("a real size", isPlaceholderValue("6x6x6 inches"), false);
check("a real finish", isPlaceholderValue("matte"), false);
check("still catches n/a", isPlaceholderValue("n/a"), true);

console.log(bad === 0 ? "\nall pass" : `\n${bad} failing`);
process.exit(bad === 0 ? 0 : 1);
