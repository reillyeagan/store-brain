import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";

import { recommendSize, runSizeChecker, coreSizing, REFERENCE_SOURCE, referenceForLine } from "../src/agents/supplier/sizeChecker.js";
import { US_REFERENCES, GARMENTS_BY_AUDIENCE, FITS, REF_SIZES, garmentOf, fitOf, referenceFor } from "../src/agents/supplier/sizeReferences.js";
import { validateChart, addPastedChart, addChartFromImage, confirmChart, chartsNeeded, resolveProduct, IMAGE_SOURCE, MAX_IMAGE_BASE64 } from "../src/agents/supplier/sizeIntake.js";
import { sizeChartFor, userPrompt } from "../src/agents/cs/replyWriter.js";
import { supplierState } from "../src/agents/supplier/index.js";
import worker from "../src/index.js";

const NOW = Date.parse("2026-10-14T16:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const KEY = "k".repeat(32);

// The real factory chart from the vault's 2026-09-15 audit: bust M110 … 4XL135, shoulder 48–53,
// length 80–85, graded linearly.
const AUDIT = ["M", "L", "XL", "2XL", "3XL", "4XL"].map((s, i) => ({ size_label: s, measurements: { chest: 110 + 5 * i, shoulder: 48 + i, length: 80 + i } }));

/* ------------------------------------------------------------ the reference library */

test("library: every audience × garment × fit has XS–4XL, a source line labelled INFERENCE, and the measurements that matter", () => {
  for (const a of ["men", "women"]) {
    for (const g of GARMENTS_BY_AUDIENCE[a]) {
      for (const f of FITS) {
        const r = US_REFERENCES[a][g][f];
        assert.deepEqual(Object.keys(r.table), REF_SIZES, `${a} ${g} ${f}`);
        assert.match(r.source, /^INFERENCE:/);
        if (f === "relaxed") {
          assert.deepEqual([...r.key], ["chest"], "any relaxed fit: chest only");
          assert.equal(r.table.M.shoulder, null, "relaxed / drop shoulder: no shoulder reference");
        }
        // Chest grows with size, always.
        for (let i = 1; i < REF_SIZES.length; i++) assert.ok(r.table[REF_SIZES[i]].chest > r.table[REF_SIZES[i - 1]].chest);
      }
    }
  }
  assert.deepEqual(GARMENTS_BY_AUDIENCE.men, ["shirt", "knit", "cardigan", "hoodie", "blazer", "coat"]);
  assert.deepEqual(GARMENTS_BY_AUDIENCE.women, ["top", "knit", "cardigan", "blazer", "coat", "dress"]);
  // The measurements that matter, as briefed.
  assert.deepEqual([...referenceFor("women", "coat").key], ["chest", "shoulder"]);
  assert.deepEqual([...referenceFor("men", "blazer").key], ["chest", "shoulder"]);
  assert.deepEqual([...referenceFor("women", "knit").key], ["chest"]);
  assert.deepEqual([...referenceFor("women", "cardigan").key], ["chest"]);
  assert.deepEqual([...referenceFor("men", "knit").key], ["chest", "length"]);
  assert.deepEqual([...referenceFor("women", "top", "fitted").key], ["chest", "shoulder"]);
  assert.deepEqual([...referenceFor("women", "dress").key], ["chest", "waist"]);
  assert.ok(referenceFor("women", "dress").table.M.waist > 0);
  // Ease ordering: a coat has more room than a knit, a knit more than a fitted blouse.
  const m = (a, g, f = "regular") => referenceFor(a, g, f).table.M.chest;
  assert.ok(m("women", "coat") > m("women", "knit") && m("women", "knit") > m("women", "top", "fitted"));
  assert.ok(m("men", "coat") > m("men", "blazer") && m("men", "blazer") > m("men", "knit") && m("men", "knit") > m("men", "shirt"));
  assert.ok(m("men", "knit", "relaxed") > m("men", "knit") && m("men", "knit") > m("men", "knit", "fitted"));
  assert.match(REFERENCE_SOURCE, /women's: blouse\/top, knit\/sweater, cardigan, blazer\/jacket, coat\/outerwear, dress/);
  assert.match(REFERENCE_SOURCE, /men's: shirt, knit\/sweater, cardigan, hoodie\/sweatshirt, blazer\/jacket, coat\/outerwear/);
});

/* ------------------------------------------------------------ detection */

test("detection: garments from Reilly's real order titles, in the right order", () => {
  const W = (t) => garmentOf(t, "women"), M = (t) => garmentOf(t, "men");
  assert.equal(W("Women's Faux Suede Relaxed Blazer, Notch Lapel Button Front Jacket"), "blazer");
  assert.equal(W("Women's Soft Fine Knit Cardigan, Button Front Crewneck Everyday Sweater"), "cardigan");
  assert.equal(W("Women's Longline Chunky Knit Cardigan, Shawl Collar Open Front Winter Sweater"), "cardigan");
  assert.equal(W("Women's Double Breasted Pea Coat, Short Notch Lapel Brushed Winter Coat"), "coat");
  assert.equal(W("Women's Tailored Blazer"), "blazer");
  assert.equal(W("Women's Striped Puffer Jacket, Hooded Quilted Zip Up Winter Jacket"), "coat");
  assert.equal(W("Women's Soft Brushed Knit Sweater, Mock Neck Relaxed Winter Pullover"), "knit");
  assert.equal(W("Elise | Twist-Front Satin Blouse, V-Neck Short-Sleeve Top"), "top");
  assert.equal(M("Men's Boxy Hooded Puffer Jacket"), "coat");
  assert.equal(M("Men's Smooth Fine Knit Sweater, Slim Fit Long Sleeve Layering Pullover"), "knit");
  assert.equal(M("Men's Corduroy Blazer"), "blazer");
  assert.equal(M("Men's Sherpa Lined Hooded Jacket, Zip Up Warm Winter Coat"), "coat");
  assert.equal(M("Men's Chunky Cable Knit Cardigan"), "cardigan");
  // Tricky ones: order matters.
  assert.equal(M("Wool Blazer Coat"), "coat", "a Blazer Coat is a coat");
  assert.equal(M("Flannel Shirt Jacket"), "blazer", "a Shirt Jacket is a jacket");
  assert.equal(W("Cable Sweater Jacket"), "cardigan", "a Sweater Jacket is a knit, not outerwear");
  assert.equal(M("Classic Dress Shirt"), "shirt", "a men's dress shirt is a shirt");
  assert.equal(W("Ribbed Sweater Dress"), "dress");
  assert.equal(M("Ribbed Sweater Dress"), "knit", "no men's dress reference");
  assert.equal(M("Men's Sweater Vest"), "knit");
  assert.equal(M("Men's Puffer Vest"), "coat");
  assert.equal(M("Men's Hoodie"), "hoodie");
  assert.equal(W("Women's Hoodie"), "knit");
  // Bottoms and skirts stay no reference.
  for (const t of ["Women's Pleated Midi Skirt", "Men's Slim Chinos", "Wide Leg Trousers"]) assert.equal(garmentOf(t, "women"), "bottoms", t);
});

test("detection: fit from the title or tags", () => {
  assert.equal(fitOf("Women's Tailored Blazer").fit, "fitted");
  assert.equal(fitOf("Men's Smooth Fine Knit Sweater, Slim Fit Long Sleeve Layering Pullover").fit, "fitted");
  assert.equal(fitOf("Bodycon Midi Dress").fit, "fitted");
  for (const t of ["Women's Faux Suede Relaxed Blazer", "Men's Boxy Hooded Puffer Jacket", "Women's Longline Chunky Knit Cardigan", "Oversized Tee", "Drop Shoulder Sweater", "Loose Knit Pullover"]) {
    assert.equal(fitOf(t).fit, "relaxed", t);
  }
  assert.equal(fitOf("Women's Double Breasted Pea Coat").fit, "regular");
  assert.equal(fitOf("Plain Sweater", ["Oversized", "Knitwear"]).fit, "relaxed", "tags count");
  assert.equal(fitOf("Plain Sweater", '["Slim Fit"]').fit, "fitted", "tags as stored (JSON)");
  const both = fitOf("Slim Fit Oversized Hoodie");
  assert.equal(both.fit, "regular");
  assert.equal(both.mixed, true);
});

test("detection: kids' items and numeric sizes get no reference", () => {
  assert.equal(recommendSize({ title: "Girls Puffer Coat", orderedSize: "M", chartRows: AUDIT, audience: "women" }).verdict, "no_reference");
  assert.equal(recommendSize({ title: "Women's Wide Leg Trousers", orderedSize: "M", chartRows: AUDIT, audience: "women" }).verdict, "no_reference");
  assert.equal(recommendSize({ title: "Women's Pea Coat", orderedSize: "8", chartRows: AUDIT, audience: "women" }).verdict, "no_reference");
});

/* ------------------------------------------------------------ recommendSize uses the library */

test("the same factory chart gives different verdicts for a women's coat, a fitted blouse and a knit", () => {
  const coat = recommendSize({ title: "Women's Double Breasted Pea Coat, Short Notch Lapel Brushed Winter Coat", orderedSize: "2XL", chartRows: AUDIT, audience: "women" });
  const blouse = recommendSize({ title: "Women's Fitted Satin Blouse", orderedSize: "2XL", chartRows: AUDIT, audience: "women" });
  const knit = recommendSize({ title: "Women's Soft Brushed Knit Sweater, Mock Neck Pullover", orderedSize: "2XL", chartRows: AUDIT, audience: "women" });
  assert.equal(coat.verdict, "size_up");
  assert.equal(coat.send_size, "3XL");
  assert.match(coat.reason, /^vs US women's coat\/outerwear \(regular fit\) reference/);
  assert.equal(blouse.verdict, "runs_large");
  assert.equal(blouse.send_size, "2XL", "never sized down");
  assert.match(blouse.reason, /vs US women's blouse\/top \(fitted fit\) reference/);
  assert.equal(knit.verdict, "as_ordered");
  assert.match(knit.reason, /vs US women's knit\/sweater \(regular fit\) reference/);
  assert.doesNotMatch(knit.reason, /length/, "women's knit: chest only (crops vary)");
  // The audit's men's reading: about one size small at M for a men's coat.
  const menCoat = recommendSize({ title: "Men's Sherpa Lined Hooded Jacket, Zip Up Warm Winter Coat", orderedSize: "M", chartRows: AUDIT, audience: "men" });
  assert.equal(menCoat.send_size, "L");
  assert.match(menCoat.reason, /vs US men's coat\/outerwear \(regular fit\) reference/);
});

test("an oversized / relaxed garment is compared only against the relaxed reference and is never sized up for being oversized", () => {
  // A deliberately big chart: reads true to size, never "runs small".
  const big = [{ size_label: "S", measurements: { chest: 104 } }, { size_label: "M", measurements: { chest: 112, shoulder: 30, length: 50 } }, { size_label: "L", measurements: { chest: 120 } }];
  const r = recommendSize({ title: "Women's Oversized Chunky Knit Sweater", orderedSize: "M", chartRows: big, audience: "women" });
  assert.equal(r.verdict, "as_ordered");
  assert.match(r.reason, /vs US women's knit\/sweater \(relaxed fit\) reference/);
  assert.doesNotMatch(r.reason, /shoulder|length/, "a cropped, drop-shoulder cut is judged on chest only");
  // A chart that only has the room of a regular knit: still shipped as ordered (no size-up for the oversize).
  const regular = [{ size_label: "M", measurements: { chest: 103 } }, { size_label: "L", measurements: { chest: 110 } }, { size_label: "XL", measurements: { chest: 118 } }];
  const o = recommendSize({ title: "Women's Oversized Knit Sweater", orderedSize: "M", chartRows: regular, audience: "women" });
  assert.equal(o.verdict, "as_ordered");
  assert.equal(o.send_size, "M");
  assert.match(o.reason, /not sized up just for being an oversized cut/);
  // The same chart on a regular knit is true to size too.
  assert.equal(recommendSize({ title: "Women's Knit Sweater", orderedSize: "M", chartRows: regular, audience: "women" }).verdict, "as_ordered");
  // Men's boxy puffer on the audit chart: the relaxed reference alone would say 2XL; capped at
  // the size the regular chest needs (L), never further for the oversize.
  const puffer = recommendSize({ title: "Men's Boxy Hooded Puffer Jacket", orderedSize: "M", chartRows: AUDIT, audience: "men" });
  assert.equal(puffer.send_size, "L");
  assert.match(puffer.reason, /relaxed fit/);
  assert.match(puffer.reason, /never sized up further just for being an oversized cut/);
  // At the top of the chart: nothing reaches the relaxed chest, but the regular chest is reached → as ordered, not "no fit".
  const top = recommendSize({ title: "Men's Boxy Hooded Puffer Jacket", orderedSize: "L", chartRows: [{ size_label: "M", measurements: { chest: 110 } }, { size_label: "L", measurements: { chest: 125 } }], audience: "men" });
  assert.equal(top.verdict, "as_ordered");
});

test("men's XS now has a reference; men's knit compares chest + length", () => {
  const chart = [{ size_label: "XS", measurements: { chest: 90, length: 66 } }, { size_label: "S", measurements: { chest: 98, length: 68 } }, { size_label: "M", measurements: { chest: 106, length: 70 } }];
  const r = recommendSize({ title: "Men's Smooth Fine Knit Sweater, Slim Fit Long Sleeve Layering Pullover", orderedSize: "XS", chartRows: chart, audience: "men" });
  assert.notEqual(r.verdict, "no_reference");
  assert.doesNotMatch(r.reason, /no US reference/);
  assert.match(r.reason, /vs US men's knit\/sweater \(fitted fit\) reference/);
  assert.match(r.reason, /length/);
  assert.ok(referenceFor("men", "knit").table.XS.chest > 0);
});

test("H&C per-product audience, mixed markers, and a product marked against its store all stay safe", () => {
  const base = { title: "Shawl Collar Cardigan", orderedSize: "M", chartRows: AUDIT };
  assert.equal(recommendSize({ ...base, audience: "both" }).verdict, "no_reference", "unmarked at H&C: never assumed");
  assert.match(recommendSize({ ...base, audience: "both", tags: ["Womens"] }).reason, /US women's cardigan/);
  assert.match(recommendSize({ ...base, audience: "both", tags: ["Mens"] }).reason, /US men's cardigan/);
  assert.equal(recommendSize({ ...base, audience: "both", tags: ["Mens", "Womens"] }).verdict, "no_reference");
  assert.equal(recommendSize({ ...base, audience: "men", tags: ["Womens"] }).verdict, "no_reference");
  assert.equal(recommendSize({ ...base, audience: "women", tags: ["Mens"] }).verdict, "no_reference");
});

test("Core overrides: sizing.us_reference:<audience>:<garment>, and the old sizing.us_reference:<garment> still means men's", async () => {
  const DB = makeD1();
  const fact = (key, value, store = null) => DB.prepare(`INSERT INTO core_facts (store, area, key, value, kind, source, observed_at, live) VALUES (?, 'sizing', ?, ?, 'rule', 'test', ?, 1)`)
    .bind(store, key, JSON.stringify(value), iso(NOW)).run();
  await fact("sizing.us_reference:women:coat", { M: { chest: 140, shoulder: 40 } });
  await fact("sizing.us_reference:jacket", { M: { chest: 90, shoulder: 40 } }); // old key: men's blazers and coats
  const core = await coreSizing(DB, "hc");
  assert.ok(core.references["women:coat"]);
  assert.ok(core.references.jacket);
  const w = recommendSize({ title: "Women's Pea Coat", orderedSize: "M", chartRows: AUDIT, audience: "women", overrides: core.references });
  assert.equal(w.verdict, "no_fit", "the Core's (deliberately huge) women's coat table is used");
  assert.match(w.reason, /Core fact sizing\.us_reference:women:coat/);
  const m = recommendSize({ title: "Men's Wool Overcoat", orderedSize: "M", chartRows: AUDIT, audience: "men", overrides: core.references });
  assert.match(m.reason, /Core fact sizing\.us_reference:jacket/);
  assert.equal(m.send_size, "M");
  // The old key never reaches a women's line.
  assert.match(recommendSize({ title: "Women's Tailored Blazer", orderedSize: "M", chartRows: AUDIT, audience: "women", overrides: core.references }).reason, /US women's blazer/);
  assert.equal(referenceForLine({ title: "Women's Pea Coat", audience: "women", overrides: {} }).garment, "coat");
});

/* ------------------------------------------------------------ intake validation */

test("intake validation: inches, flat, the inches-or-flat question, bad rows", () => {
  const inch = validateChart({ unit: "in", rows: [{ size: "M", chest: 44, length: 28 }, { size: "L", chest: 46, length: 29 }] });
  assert.equal(inch.ok, true);
  assert.equal(inch.rows[0].chest, 111.8);
  assert.equal(inch.rows[0].length, 71.1);
  const flat = validateChart({ unit: "cm", flat: true, rows: [{ size: "S", chest: 52, waist: 40 }, { size: "M", chest: 55, waist: 43 }] });
  assert.equal(flat.rows[1].chest, 110);
  assert.equal(flat.rows[1].waist, 86);
  // Never silently doubled: chests under 75cm need the unit AND an explicit flat tick.
  const names = validateChart({ rows: [{ size: "m", chest: 110 }, { size: "XXL", chest: "125" }] });
  assert.deepEqual(names.rows.map((r) => [r.size, r.chest]), [["M", 110], ["2XL", 125]]);
  const inchesAsCm = validateChart({ unit: "cm", rows: [{ size: "M", chest: 44 }, { size: "L", chest: 46 }] });
  assert.equal(inchesAsCm.ok, false);
  assert.match(inchesAsCm.error, /unclear: inches or a flat \(half\) measurement\? say which/);
  assert.match(validateChart({ rows: [{ size: "M", chest: 55 }, { size: "L", chest: 57 }] }).error, /unclear/, "no unit, no flat: refused");
  assert.match(validateChart({ flat: true, rows: [{ size: "M", chest: 55 }, { size: "L", chest: 57 }] }).error, /unclear/, "flat but no unit: refused");
  assert.match(validateChart({ unit: "cm", flat: false, rows: [{ size: "M", chest: 55 }, { size: "L", chest: 57 }] }).error, /unclear/);
  assert.match(validateChart({ unit: "in", rows: [{ size: "M", chest: 22 }, { size: "L", chest: 23 }] }).error, /unclear/, "22in could be a flat inch chart");
  assert.equal(validateChart({ unit: "in", flat: true, rows: [{ size: "M", chest: 22 }, { size: "L", chest: 23 }] }).rows[0].chest, 111.8);
  const bad = (rows, extra = {}) => validateChart({ rows, ...extra });
  assert.match(bad([{ size: "L", chest: 115 }, { size: "M", chest: 110 }]).error, /out of order/);
  assert.match(bad([{ size: "M", chest: 110 }, { size: "M", chest: 115 }]).error, /out of order/);
  assert.match(bad([{ size: "M", chest: 110 }]).error, /at least 2 sizes/);
  assert.match(bad([{ size: "M", chest: 250 }, { size: "L", chest: 260 }]).error, /outside 60–200cm/);
  assert.match(bad([{ size: "M", chest: 110 }, { size: "L", chest: 115 }], { unit: "cm", flat: true }).error, /outside 60–200cm/, "flat on a full chest doubles past 200");
  assert.match(bad([{ size: "M", chest: 20 }, { size: "L", chest: 22 }], { unit: "cm", flat: true }).error, /outside 60–200cm/, "even doubled, 40cm is nonsense");
  assert.match(bad([{ size: "M", chest: 110 }, { size: "L", chest: 105 }]).error, /gets smaller/);
  assert.match(bad([{ size: "M", chest: "abc" }, { size: "L", chest: 105 }]).error, /not a number/);
  assert.match(bad([{ size: "32", chest: 110 }, { size: "34", chest: 115 }]).error, /not a letter size/);
  assert.match(bad([{ size: "M" }, { size: "L", chest: 115 }]).error, /chest is required/);
  assert.match(validateChart({ unit: "mm", rows: [{ size: "M", chest: 110 }, { size: "L", chest: 115 }] }).error, /unit/);
});

/* ------------------------------------------------------------ intake: saving, re-check, confirm */

async function seedOrder(DB, { store = "aub", n, product = "p1", handle = "pea-coat", title = "Women's Double Breasted Pea Coat, Short Notch Lapel Brushed Winter Coat", size = "2XL", createdMs = NOW - 3600000 }) {
  await DB.prepare(`INSERT INTO orders (store, order_id, name, created_at, local_day, total, financial_status, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(store, `gid://shopify/Order/${n}`, `#${n}`, iso(createdMs), "2026-10-14", 60, "paid", iso(NOW)).run();
  await DB.prepare(`INSERT INTO order_lines (store, order_id, line_id, product_id, product_handle, title, variant_title, size, quantity, price, updated_at)
    VALUES (?,?,?,?,?,?,?,?,1,60,?)`).bind(store, `gid://shopify/Order/${n}`, `gid://shopify/LineItem/${n}`, `gid://shopify/Product/${product}`,
    handle, title, `Navy / ${size}`, size, iso(NOW)).run();
}
const AUDIT_ROWS = AUDIT.map((r) => ({ size: r.size_label, ...r.measurements }));

test("paste intake: saves unconfirmed (no KFB ask), re-checks the product at once; confirm refreshes the line and only then makes the ask", async () => {
  const DB = makeD1();
  const env = { DB };
  await seedOrder(DB, { n: 2001 });
  await DB.prepare(`INSERT INTO cat_products (store, product_id, handle, title, read_at) VALUES ('aub', 'gid://shopify/Product/p1', 'pea-coat', 'Pea Coat', ?)`).bind(iso(NOW)).run();
  await runSizeChecker(env, { nowMs: NOW });
  assert.equal((await DB.prepare(`SELECT verdict FROM size_recommendations`).first()).verdict, "no_chart");

  const r = await addPastedChart(env, { store: "aub", product_handle: "https://auberlane.com/products/pea-coat?variant=1", unit: "cm", flat: false, rows: AUDIT_ROWS }, { nowMs: NOW + 60000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.product_id, "gid://shopify/Product/p1");
  assert.equal(r.product_handle, "pea-coat");
  assert.equal(r.verified, 0);
  const rows = (await DB.prepare(`SELECT * FROM size_charts ORDER BY size_label`).all()).results;
  assert.equal(rows.length, 6);
  assert.ok(rows.every((x) => x.verified === 0 && x.source.startsWith(`intake:${r.id} `)));
  // Re-checked straight away: the women's coat reference says 3XL, but the chart is unconfirmed → no ask.
  let rec = await DB.prepare(`SELECT verdict, send_size, reason, chart_verified FROM size_recommendations`).first();
  assert.equal(rec.verdict, "size_up");
  assert.equal(rec.send_size, "3XL");
  assert.equal(rec.chart_verified, 0);
  assert.match(rec.reason, /vs US women's coat\/outerwear \(regular fit\) reference/);
  assert.match(rec.reason, /Pending your chart confirm/);
  assert.match(rec.reason, /chart pasted by Reilly, not yet confirmed/);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM kfb_size_asks`).first()).n, 0, "an unconfirmed chart never makes a KFB ask");
  assert.ok(await DB.prepare(`SELECT id FROM events WHERE kind = 'size_chart.added' AND actor = 'sup.size_charts'`).first());

  const c = await confirmChart(env, r.id, { nowMs: NOW + 120000 });
  assert.equal(c.ok, true);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM size_charts WHERE verified = 1`).first()).n, 6);
  const ev = await DB.prepare(`SELECT actor, summary FROM events WHERE kind = 'size_chart.confirmed'`).first();
  assert.equal(ev.actor, "sup.size_charts");
  assert.match(ev.summary, /confirmed by Reilly/);
  rec = await DB.prepare(`SELECT reason, chart_verified FROM size_recommendations`).first();
  assert.equal(rec.chart_verified, 1, "refreshed on confirm");
  assert.doesNotMatch(rec.reason, /not yet confirmed|Pending your chart confirm/);
  const ask = await DB.prepare(`SELECT send_size, status FROM kfb_size_asks`).first();
  assert.deepEqual([ask.send_size, ask.status], ["3XL", "pending"]);
  // A confirmed chart is not replaced by accident.
  const again = await addPastedChart(env, { store: "aub", product_handle: "pea-coat", unit: "cm", rows: AUDIT_ROWS }, { nowMs: NOW + 180000 });
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  assert.equal((await confirmChart(env, 999)).status, 404);
});

test("fixing a chart undoes what the wrong chart decided: lines re-decided, a pending ask that no longer holds is withdrawn (never deleted)", async () => {
  const DB = makeD1();
  const env = { DB };
  await seedOrder(DB, { n: 2101, size: "M" });
  // A wrong chart (too small), confirmed → size-up + ask.
  const small = [{ size: "M", chest: 96 }, { size: "L", chest: 104 }, { size: "XL", chest: 112 }];
  const r1 = await addPastedChart(env, { store: "aub", product_handle: "pea-coat", unit: "cm", rows: small }, { nowMs: NOW });
  await confirmChart(env, r1.id, { nowMs: NOW + 1000 });
  let ask = await DB.prepare(`SELECT * FROM kfb_size_asks`).first();
  assert.equal(ask.status, "pending");
  assert.equal(ask.send_size, "L");
  // Reilly replaces it with the right chart: the M line is re-decided (it was size_up, not no_chart).
  const r2 = await addPastedChart(env, { store: "aub", product_handle: "pea-coat", unit: "cm", replace: true, rows: AUDIT_ROWS }, { nowMs: NOW + 2000 });
  assert.equal(r2.ok, true, r2.error);
  const rec = await DB.prepare(`SELECT verdict, send_size, chart_verified FROM size_recommendations`).first();
  assert.equal(rec.verdict, "as_ordered");
  assert.equal(rec.chart_verified, 0);
  const asks = (await DB.prepare(`SELECT * FROM kfb_size_asks`).all()).results;
  assert.equal(asks.length, 1, "never deleted");
  assert.equal(asks[0].status, "withdrawn");
  assert.match(asks[0].why, /withdrawn .*no longer holds \(now as ordered M, chart pasted by Reilly, not yet confirmed\)/);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM kfb_size_asks WHERE status = 'pending'`).first()).n, 0);
  assert.match((await DB.prepare(`SELECT summary FROM events WHERE kind = 'sizes.checked' ORDER BY id DESC`).first()).summary, /1 ask withdrawn/);
});

test("image-read chart: the reason names it as read by the brain from an image, not yet confirmed", async () => {
  const DB = makeD1();
  await seedOrder(DB, { n: 2201 });
  await DB.prepare(`INSERT INTO size_charts (store, product_id, product_handle, size_label, measurements, source, verified) VALUES ('aub', 'handle:pea-coat', 'pea-coat', 'XL', '{"chest":120}', ?, 0)`).bind(`intake:1 · ${IMAGE_SOURCE}`).run();
  await DB.prepare(`INSERT INTO size_charts (store, product_id, product_handle, size_label, measurements, source, verified) VALUES ('aub', 'handle:pea-coat', 'pea-coat', '2XL', '{"chest":125}', ?, 0)`).bind(`intake:1 · ${IMAGE_SOURCE}`).run();
  await runSizeChecker({ DB }, { nowMs: NOW });
  const rec = await DB.prepare(`SELECT reason FROM size_recommendations`).first();
  assert.match(rec.reason, /chart read by the brain from an image, not yet confirmed/);
});

test("an unconfirmed chart still lets the complaints logic ask (complaints are their own evidence)", async () => {
  const DB = makeD1();
  await seedOrder(DB, { n: 2301, size: "M" });
  await DB.prepare(`INSERT INTO cat_products (store, product_id, handle, title, variants, read_at) VALUES ('aub', 'gid://shopify/Product/p1', 'pea-coat', 'Pea Coat', ?, ?)`)
    .bind(JSON.stringify([{ title: "Navy / M" }, { title: "Navy / L" }, { title: "Navy / XL" }]), iso(NOW)).run();
  for (let i = 0; i < 2; i++) {
    await DB.prepare(`INSERT INTO size_complaints (store, product_id, size_ordered, size_that_fits, said, at) VALUES ('aub', 'gid://shopify/Product/p1', 'M', 'L', 'too small', ?)`).bind(iso(NOW)).run();
  }
  await addPastedChart({ DB }, { store: "aub", product_handle: "pea-coat", unit: "cm", rows: AUDIT_ROWS }, { nowMs: NOW });
  const ask = await DB.prepare(`SELECT send_size, why FROM kfb_size_asks`).first();
  assert.equal(ask.send_size, "L");
  assert.match(ask.why, /customer complaints \(the chart is pending your confirm\)/);
});

test("review fixes: chest decides; shoulder/length shortfalls are notes with conflict, never a size-up", () => {
  // Men's knit: a US M sweater with a short length stays M; slim XS stays XS.
  const knit = [{ size_label: "M", measurements: { chest: 112, length: 68.5 } }, { size_label: "L", measurements: { chest: 122, length: 71 } }];
  const k = recommendSize({ title: "Men's Merino Sweater", orderedSize: "M", chartRows: knit, audience: "men" });
  assert.equal(k.send_size, "M");
  assert.equal(k.conflict, true);
  assert.match(k.reason, /length shortfall is noted only/);
  const slim = [{ size_label: "XS", measurements: { chest: 92, length: 64 } }, { size_label: "S", measurements: { chest: 98, length: 67 } }];
  assert.equal(recommendSize({ title: "Men's Smooth Fine Knit Sweater, Slim Fit Long Sleeve Layering Pullover", orderedSize: "XS", chartRows: slim, audience: "men" }).send_size, "XS");
  const hoodie = recommendSize({ title: "Men's Hoodie", orderedSize: "M", chartRows: [{ size_label: "M", measurements: { chest: 114, length: 66 } }, { size_label: "L", measurements: { chest: 122, length: 70 } }], audience: "men" });
  assert.equal(hoodie.send_size, "M");
  // Women's longline coat L: the chest fits, the shoulder is short → stays L, conflict noted.
  const coatChart = [{ size_label: "M", measurements: { chest: 108, shoulder: 37 } }, { size_label: "L", measurements: { chest: 116, shoulder: 38.5 } }, { size_label: "XL", measurements: { chest: 122, shoulder: 40.5 } }];
  const coat = recommendSize({ title: "Women's Longline Wool Coat", orderedSize: "L", chartRows: coatChart, audience: "women" });
  assert.equal(coat.send_size, "L");
  assert.equal(coat.verdict, "as_ordered");
  assert.equal(coat.conflict, true);
  assert.match(coat.reason, /chest says L, shoulder says XL/);
  // When the chest itself falls short, it still goes up (never above the largest listed).
  const smallChest = [{ size_label: "M", measurements: { chest: 100, shoulder: 40 } }, { size_label: "L", measurements: { chest: 108, shoulder: 41 } }];
  const up = recommendSize({ title: "Women's Longline Wool Coat", orderedSize: "M", chartRows: smallChest, audience: "women" });
  assert.equal(up.verdict, "size_up");
  assert.equal(up.send_size, "L");
  const top = recommendSize({ title: "Women's Longline Wool Coat", orderedSize: "L", chartRows: smallChest, audience: "women" });
  assert.equal(top.verdict, "no_fit", "never above the largest listed size");
  assert.equal(top.send_size, null);
});

test("review fixes: a women's blouse with no fit word uses the fitted-blouse ease; a dress is sized on the chest only", () => {
  const elise = [{ size_label: "S", measurements: { chest: 92, shoulder: 36 } }, { size_label: "M", measurements: { chest: 98, shoulder: 37.5 } }, { size_label: "L", measurements: { chest: 104, shoulder: 39 } }];
  const b = recommendSize({ title: "Elise | Twist-Front Satin Blouse, V-Neck Short-Sleeve Top", orderedSize: "M", chartRows: elise, audience: "women" });
  assert.equal(b.send_size, "M");
  assert.match(b.reason, /blouse\/top \(regular fit\)/);
  assert.equal(referenceFor("women", "top", "regular").table.M.chest, referenceFor("women", "top", "fitted").table.M.chest + 0, "regular = fitted-blouse ease");
  assert.ok(referenceFor("women", "top", "relaxed").table.M.chest > referenceFor("women", "top", "regular").table.M.chest, "relaxed titles get the relaxed allowance");
  // Smocked / elastic waist dress: waist 68 is a note, not a no-fit.
  const dress = [{ size_label: "S", measurements: { chest: 90, waist: 64 } }, { size_label: "M", measurements: { chest: 98, waist: 68 } }, { size_label: "L", measurements: { chest: 104, waist: 72 } }];
  const d = recommendSize({ title: "Women's Smocked Midi Dress", orderedSize: "M", chartRows: dress, audience: "women" });
  assert.equal(d.verdict, "as_ordered");
  assert.equal(d.send_size, "M");
  assert.match(d.reason, /waist/);
});

test("review fixes: replacing a chart is all or nothing (one batch)", async () => {
  const DB = makeD1();
  const r1 = await addPastedChart({ DB }, { store: "mar", product_handle: "knit", unit: "cm", rows: AUDIT_ROWS }, { nowMs: NOW });
  assert.equal(r1.ok, true);
  DB._failBatchAt = 3; // the third insert fails
  await assert.rejects(addPastedChart({ DB }, { store: "mar", product_handle: "knit", unit: "cm", rows: AUDIT_ROWS.slice(0, 4) }, { nowMs: NOW + 1000 }));
  DB._failBatchAt = null;
  const rows = (await DB.prepare(`SELECT source FROM size_charts`).all()).results;
  assert.equal(rows.length, 6, "the old chart is intact");
  assert.ok(rows.every((x) => x.source.startsWith(`intake:${r1.id} `)));
});

test("review fixes: image route refuses a confirmed product before the paid call, refuses an image with no unit, and caps the size", async () => {
  const DB = makeD1();
  const env = { DB, ANTHROPIC_API_KEY: "sk-ant-test-key-123456" };
  let calls = 0;
  const answer = (j) => async (url, init) => { calls++; return new Response(JSON.stringify({ model: "m", content: [{ type: "text", text: JSON.stringify(j) }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 }); };
  // No explicit unit from the model → refused, nothing saved.
  const noUnit = await addChartFromImage(env, { store: "mar", product_handle: "knit", image_base64: "iVBORw0KGgo=", media_type: "image/png" }, { fetchImpl: answer({ rows: [{ size: "M", chest: 110 }, { size: "L", chest: 115 }] }), nowMs: NOW });
  assert.equal(noUnit.status, 422);
  assert.match(noUnit.error, /unclear: inches or a flat/);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM size_charts`).first()).n, 0);
  // Confirmed chart → 409 before any AI call.
  const r = await addPastedChart({ DB }, { store: "mar", product_handle: "knit", unit: "cm", rows: AUDIT_ROWS }, { nowMs: NOW });
  await confirmChart({ DB }, r.id, { nowMs: NOW });
  calls = 0;
  const blocked = await addChartFromImage(env, { store: "mar", product_handle: "knit", image_base64: "iVBORw0KGgo=", media_type: "image/png" }, { fetchImpl: answer({ unit: "cm", rows: [] }), nowMs: NOW });
  assert.equal(blocked.status, 409);
  assert.equal(calls, 0, "no paid call");
  // Size cap: 5,242,880 base64 characters.
  const big = await addChartFromImage(env, { store: "mar", product_handle: "other", image_base64: "A".repeat(5_242_884), media_type: "image/png" }, { fetchImpl: answer({}), nowMs: NOW });
  assert.equal(big.status, 400);
  assert.match(big.error, /3\.75 MB/);
  assert.equal(MAX_IMAGE_BASE64, 5_242_880);
  assert.equal(calls, 0);
});

test("CS drafts: an unconfirmed chart is labelled 'factory chart, unconfirmed' in what the model sees", async () => {
  const DB = makeD1();
  await DB.prepare(`INSERT INTO size_charts (store, product_id, size_label, measurements, source, verified) VALUES ('aub', 'gid://shopify/Product/p1', 'M', '{"chest":110}', 'intake:1 · x', 0)`).run();
  const chart = await sizeChartFor(DB, { store: "aub", items: [{ product_id: "gid://shopify/Product/p1", title: "Pea Coat" }] });
  assert.equal(chart[0].label, "factory chart, unconfirmed");
  const prompt = userPrompt({ category: "size", body: "will it fit?" }, null, chart);
  assert.match(prompt, /factory chart, unconfirmed/);
  assert.match(prompt, /never as confirmed fact/);
});

test("paste intake: an unknown handle is kept as handle:<handle> and still matches order lines; non-live stores and bad ids refused", async () => {
  const DB = makeD1();
  const r = await addPastedChart({ DB }, { store: "mar", product_handle: "mystery-knit", rows: AUDIT_ROWS }, { nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.product_id, "handle:mystery-knit");
  assert.equal(r.resolved, false);
  assert.equal((await addPastedChart({ DB }, { store: "tund", product_handle: "x", rows: AUDIT_ROWS })).status, 400);
  assert.equal((await addPastedChart({ DB }, { store: "zz", product_handle: "x", rows: AUDIT_ROWS })).status, 400);
  assert.equal((await addPastedChart({ DB }, { store: "mar", rows: AUDIT_ROWS })).status, 400);
  assert.equal((await addPastedChart({ DB }, { store: "mar", product_id: "not-an-id", rows: AUDIT_ROWS })).status, 400);
  const byId = await resolveProduct(DB, "mar", { product_id: "123" });
  assert.equal(byId.productId, "gid://shopify/Product/123");
  // A newer chart for the same product replaces the rows; the older intake can't be confirmed any more.
  const r2 = await addPastedChart({ DB }, { store: "mar", product_handle: "mystery-knit", rows: AUDIT_ROWS.slice(0, 3) }, { nowMs: NOW + 1000 });
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM size_charts WHERE store = 'mar'`).first()).n, 3);
  assert.equal((await confirmChart({ DB }, r.id)).status, 409);
  assert.equal((await confirmChart({ DB }, r2.id)).ok, true);
});

test("image intake (mocked Claude): one call, cost logged, same validation, ALWAYS verified=0", async () => {
  const DB = makeD1();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answer = { unit: "cm", flat: true, verified: 1, rows: [{ size: "M", chest: 55, shoulder: 48, length: 80 }, { size: "L", chest: 57.5, shoulder: 49, length: 81 }, { size: "XL", chest: 60, shoulder: 50, length: 82 }] };
    return new Response(JSON.stringify({ model: body.model, content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 1500, output_tokens: 120 }, stop_reason: "end_turn" }), { status: 200 });
  };
  const env = { DB, ANTHROPIC_API_KEY: "sk-ant-test-key-123456" };
  const r = await addChartFromImage(env, { store: "aub", product_handle: "pea-coat", image_base64: "data:image/png;base64,iVBORw0KGgo=", media_type: "image/png", verified: 1 }, { fetchImpl, nowMs: NOW });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.verified, 0);
  assert.equal(calls.length, 1, "one call");
  const content = calls[0].messages[0].content;
  assert.equal(content[0].type, "image");
  assert.equal(content[0].source.media_type, "image/png");
  assert.equal(content[0].source.data, "iVBORw0KGgo=");
  assert.equal(content[1].type, "text");
  assert.deepEqual(r.rows.map((x) => x.chest), [110, 115, 120], "flat chest doubled");
  const rows = (await DB.prepare(`SELECT verified, source FROM size_charts`).all()).results;
  assert.ok(rows.length === 3 && rows.every((x) => x.verified === 0 && x.source.includes(IMAGE_SOURCE)));
  const it = await DB.prepare(`SELECT verified, kind, source FROM size_chart_intakes`).first();
  assert.equal(it.verified, 0);
  assert.equal(it.kind, "image");
  assert.equal(it.source, "read by the brain from an image, not yet checked by Reilly");
  const cost = await DB.prepare(`SELECT cost_usd, actor FROM events WHERE kind = 'ai.call'`).first();
  assert.ok(cost.cost_usd > 0);
  assert.equal(cost.actor, "sup.size_charts");
  assert.ok(!JSON.stringify((await DB.prepare(`SELECT * FROM events`).all()).results).includes("sk-ant-test-key-123456"));

  // A bad read fails the same validation and saves nothing.
  const badFetch = async (url, init) => new Response(JSON.stringify({ model: "m", content: [{ type: "text", text: JSON.stringify({ unit: "cm", rows: [{ size: "L", chest: 115 }, { size: "M", chest: 110 }] }) }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 });
  const bad = await addChartFromImage(env, { store: "aub", product_handle: "other", image_base64: "iVBORw0KGgo=", media_type: "image/png" }, { fetchImpl: badFetch, nowMs: NOW });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 422);
  assert.match(bad.error, /out of order/);
  // No key → not wired, no call; wrong type → refused before any call.
  let n = 0;
  const nokey = await addChartFromImage({ DB }, { store: "aub", product_handle: "x", image_base64: "iVBORw0KGgo=", media_type: "image/png" }, { fetchImpl: async () => { n++; }, nowMs: NOW });
  assert.equal(nokey.status, 503);
  assert.equal((await addChartFromImage(env, { store: "aub", product_handle: "x", image_base64: "iVBORw0KGgo=", media_type: "application/pdf" }, { fetchImpl: async () => { n++; } })).status, 400);
  assert.equal(n, 0);
});

/* ------------------------------------------------------------ charts needed */

test("charts needed: sized lines in 30 days with no chart, by product, most lines first; bottoms, old lines and charted products left out", async () => {
  const DB = makeD1();
  await seedOrder(DB, { n: 3001, product: "coat", handle: "pea-coat" });
  await seedOrder(DB, { n: 3002, product: "coat", handle: "pea-coat", size: "M" });
  await seedOrder(DB, { n: 3003, product: "coat", handle: "pea-coat", size: "L" });
  await seedOrder(DB, { n: 3004, store: "mar", product: "knit", handle: "fine-knit", title: "Men's Smooth Fine Knit Sweater" });
  await seedOrder(DB, { n: 3005, product: "skirt", handle: "midi-skirt", title: "Women's Pleated Midi Skirt" });
  await seedOrder(DB, { n: 3006, product: "old", handle: "old-coat", createdMs: NOW - 40 * 86400000 });
  await seedOrder(DB, { n: 3007, store: "hc", product: "charted", handle: "charted-blazer", title: "Men's Corduroy Blazer" });
  await seedOrder(DB, { n: 3008, store: "hc", product: "pants", handle: "waist-pants", title: "Relaxed Linen Something", size: "32" });
  await DB.prepare(`INSERT INTO size_charts (store, product_id, size_label, measurements, source, verified) VALUES ('hc', 'gid://shopify/Product/charted', 'M', '{"chest":110}', 'test', 1)`).run();
  const need = await chartsNeeded(DB, { nowMs: NOW });
  assert.deepEqual(need.map((x) => [x.store, x.product_handle, x.lines]), [["aub", "pea-coat", 3], ["mar", "fine-knit", 1]]);
  assert.equal(need[0].sizes, "M, L, 2XL");
  assert.equal(need[0].storeName, "Auberlane");
  assert.match(need[0].title, /Pea Coat/);
  const st = await supplierState({ DB }, { nowMs: NOW });
  assert.equal(st.agents["sup.size_charts"].chartsNeeded.length, 2);
  assert.deepEqual(st.agents["sup.size_charts"].charts, []);
  assert.match(st.agents["sup.size_charts"].reference, /women's: blouse\/top/);
});

/* ------------------------------------------------------------ routes */

test("routes: /api/size-charts and /confirm need the key; with it, a paste saves and confirm works", async () => {
  const DB = makeD1();
  const env = { DB, MC_KEY: KEY };
  const post = (path, body, key = null) => worker.fetch(new Request(`https://b.example${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-store-brain-key": key } : {}) }, body: JSON.stringify(body),
  }), env);
  const body = { store: "hc", product_handle: "wool-blazer", unit: "cm", flat: false, rows: AUDIT_ROWS };
  assert.equal((await post("/api/size-charts", body)).status, 401);
  assert.equal((await post("/api/size-charts", body, "x".repeat(32))).status, 401);
  assert.equal((await post("/api/size-charts/image", { ...body, image_base64: "iVBORw0KGgo=", media_type: "image/png" })).status, 401);
  assert.equal((await post("/api/size-charts/1/confirm", {})).status, 401);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM size_charts`).first()).n, 0, "nothing saved without the key");
  const ok = await post("/api/size-charts", body, KEY);
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.verified, 0);
  const bad = await post("/api/size-charts", { ...body, rows: [{ size: "M", chest: 300 }, { size: "L", chest: 310 }] }, KEY);
  assert.equal(bad.status, 400);
  const conf = await post(`/api/size-charts/${j.id}/confirm`, {}, KEY);
  assert.equal(conf.status, 200);
  assert.equal((await post("/api/size-charts/999/confirm", {}, KEY)).status, 404);
  // Image route without an AI key: not wired, nothing saved.
  const img = await post("/api/size-charts/image", { store: "hc", product_handle: "other", image_base64: "iVBORw0KGgo=", media_type: "image/png" }, KEY);
  assert.equal(img.status, 503);
});
