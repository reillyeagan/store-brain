import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Production config, without the test fixture override: only Holt & Crane is live
// (Reilly 2026-10-27: "marlowe and auberlane are no longer live ... only focused on H&C now").
test("stores: in production only Holt & Crane is live; Auberlane and Marlowe are closed with their history kept", () => {
  const env = { ...process.env }; delete env.SB_TEST_LIVE_STORES;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { LIVE_STORE_IDS, STORES } from "./src/config/stores.js"; console.log(JSON.stringify({ live: LIVE_STORE_IDS, aub: STORES.aub.closedOn, mar: STORES.mar.closedOn }));`], { env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), { live: ["hc"], aub: "2026-10-27", mar: "2026-10-27" });
});

test("closed store: its leftover non-email approvals come off the list once; customer-email flags stay", async () => {
  const env = { ...process.env, SB_TEST_LIVE_STORES: "hc" };
  const script = `
    import { makeD1 } from "./test/helpers/d1.js";
    import { createApproval } from "./src/lib/approvals.js";
    import { closeStoreWork } from "./src/lib/closedStores.js";
    const DB = makeD1();
    await createApproval(DB, { dept: "catalog", requestedBy: "cat.pricing", store: "mar", title: "price", options: [{ id: "a", label: "a" }] });
    await createApproval(DB, { dept: "cs", requestedBy: "cs.escalation", store: "aub", title: "email", options: [{ id: "h", label: "h" }] });
    await createApproval(DB, { dept: "catalog", requestedBy: "cat.pricing", store: "hc", title: "hc price", options: [{ id: "a", label: "a" }] });
    const r1 = await closeStoreWork({ DB }); const r2 = await closeStoreWork({ DB });
    const rows = (await DB.prepare("SELECT store, requested_by, status FROM approvals ORDER BY id").all()).results;
    console.log(JSON.stringify({ r1, r2, rows }));`;
  const out = JSON.parse(execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { env, encoding: "utf8" }).trim().split("\n").pop());
  assert.deepEqual(out.rows.map((r) => r.status), ["expired", "pending", "pending"]);
  assert.equal(out.r1.find((x) => x.store === "mar").closed, 1);
  assert.equal(out.r2.length, 0, "once only");
});
