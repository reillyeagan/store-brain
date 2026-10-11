/**
 * Backup Vault — a durable snapshot before any bulk change.
 *
 * Why: a rollback was once promised from a backup that lived in temporary scratch
 * space and was already gone. Backups now go to R2 (durable), and we read the
 * object's metadata back before claiming a rollback exists.
 */
import { nowIso } from "./time.js";

/**
 * @param {R2Bucket} bucket  env.BACKUPS
 * @param {{store:string|null, label:string, data:any, atIso?:string}} p
 * @returns {Promise<{ok:true, key:string, size:number}>}
 */
export async function backup(bucket, { store, label, data, atIso = nowIso() }) {
  if (!bucket) throw new Error("Backup Vault is not bound (BACKUPS). Refusing to run a bulk change without a backup.");
  if (!label) throw new Error("backup needs a label");
  const safeLabel = String(label).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
  const key = `backups/${store || "all"}/${atIso.replace(/[:.]/g, "-")}_${safeLabel}.json`;
  const body = JSON.stringify({ store, label, at: atIso, data });
  await bucket.put(key, body, { httpMetadata: { contentType: "application/json" } });
  const head = await bucket.head(key);
  if (!head || head.size !== new TextEncoder().encode(body).length) {
    throw new Error(`Backup not confirmed for ${key}. Do not proceed with the change.`);
  }
  return { ok: true, key, size: head.size };
}

/** Read a backup back (for a rollback). */
export async function readBackup(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`No backup at ${key}`);
  return JSON.parse(await obj.text());
}
