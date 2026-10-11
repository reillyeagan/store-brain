/**
 * Write-Verifier — a write only counts once the system of record shows it.
 *
 * Why: an Ads Script "saved" with HTTP 200 while the server kept the old code;
 * Sheets writes silently did nothing; "done" was reported with nothing shipped.
 * So the write's own response is ignored for proof. We read the target back
 * (with a few retries, because some systems lag) and check what's actually there.
 *
 * @param {object} p
 * @param {() => Promise<any>} p.write    performs the change
 * @param {() => Promise<any>} p.read     reads the target from the system of record
 * @param {(readBack:any) => boolean} p.expect  true when the read-back shows the change
 * @param {number} [p.attempts=3]
 * @param {number} [p.delayMs=1500]
 * @param {(ms:number)=>Promise<void>} [p.sleep]
 * @returns {Promise<{ok:boolean, attempts:number, readBack:any, writeResult:any, error?:string}>}
 */
export async function verifiedWrite({ write, read, expect, attempts = 3, delayMs = 1500, sleep }) {
  if (typeof write !== "function" || typeof read !== "function" || typeof expect !== "function") {
    throw new Error("verifiedWrite needs write, read and expect functions");
  }
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let writeResult;
  try {
    writeResult = await write();
  } catch (err) {
    return { ok: false, attempts: 0, readBack: null, writeResult: null, error: `write threw: ${err.message}` };
  }
  let readBack = null;
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      readBack = await read();
      if (expect(readBack)) return { ok: true, attempts: i, readBack, writeResult };
    } catch (err) {
      lastErr = err.message;
    }
    if (i < attempts) await wait(delayMs * i);
  }
  return {
    ok: false,
    attempts,
    readBack,
    writeResult,
    error: lastErr ? `read-back failed: ${lastErr}` : "read-back does not show the change",
  };
}
