// Google Drive: sign-in (drive.file scope — only files this app creates) and background upload queue.
import { db, prefs, blobKey } from "./db.js";
import { GOOGLE_CLIENT_ID } from "./config.js";
import { buildCsv, csvName } from "./csv.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

let token = null, tokenExp = 0, client = null, pending = null;
const listeners = new Set();
let state = { text: "Drive off", kind: "idle" };

export const clientId = () => prefs.get("clientId", "") || GOOGLE_CLIENT_ID;
export const driveOn = () => prefs.get("driveOn", false);
export const driveState = () => state;
export function onDrive(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function setState(text, kind) { state = { text, kind }; listeners.forEach(f => f(state)); }

function gis() {
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (window.google && google.accounts && google.accounts.oauth2) { clearInterval(t); resolve(); }
      else if (++n > 100) { clearInterval(t); reject(new Error("Google sign-in didn't load — check your connection")); }
    }, 100);
  });
}

async function ensureClient() {
  if (!clientId()) throw new Error("Add the Google Client ID in Settings first");
  await gis();
  if (!client) {
    client = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPE,
      callback: r => {
        const p = pending; pending = null;
        if (!p) return;
        if (r.error) p.reject(new Error(r.error_description || r.error));
        else { token = r.access_token; tokenExp = Date.now() + (Number(r.expires_in || 3600) - 120) * 1000; p.resolve(token); }
      },
      error_callback: e => { const p = pending; pending = null; if (p) p.reject(new Error(e.message || e.type || "sign-in closed")); },
    });
  }
}

/** Interactive sign-in. Call from a tap (browsers block pop-ups otherwise). */
export async function connectDrive() {
  await ensureClient();
  const t = await new Promise((resolve, reject) => { pending = { resolve, reject }; client.requestAccessToken({ prompt: token ? "" : "consent" }); });
  prefs.set("driveOn", true);
  kick();
  return t;
}
export function disconnectDrive() {
  prefs.set("driveOn", false);
  if (token && window.google) google.accounts.oauth2.revoke(token, () => {});
  token = null;
  setState("Drive off", "idle");
}

function validToken() { return token && Date.now() < tokenExp ? token : null; }

async function api(url, opts = {}) {
  const t = validToken();
  if (!t) throw Object.assign(new Error("signin"), { signin: true });
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + t } });
  if (r.status === 401) { token = null; throw Object.assign(new Error("signin"), { signin: true }); }
  if (r.status === 404) throw Object.assign(new Error("not found"), { notFound: true });
  if (!r.ok) throw new Error("Drive " + r.status + ": " + (await r.text()).slice(0, 160));
  const txt = await r.text();
  return txt ? JSON.parse(txt) : {};
}

async function createFolder(name, parent) {
  const meta = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parent) meta.parents = [parent];
  return (await api(API + "?fields=id", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(meta) })).id;
}
async function exists(id) {
  try { const j = await api(`${API}/${id}?fields=id,trashed`); return !j.trashed; }
  catch (e) { if (e.notFound) return false; throw e; }
}
async function upload(parent, name, blob, mime) {
  const boundary = "ac" + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: [parent] });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, blob, `\r\n--${boundary}--`,
  ]);
  return (await api(UPLOAD + "?uploadType=multipart&fields=id", { method: "POST", headers: { "content-type": "multipart/related; boundary=" + boundary }, body })).id;
}
async function update(id, blob, mime) {
  await api(`${UPLOAD}/${id}?uploadType=media&fields=id`, { method: "PATCH", headers: { "content-type": mime }, body: blob });
}
async function remove(id) {
  try { await api(`${API}/${id}`, { method: "DELETE" }); } catch (e) { if (!e.notFound) throw e; }
}

async function ensureFolder(a) {
  if (a.driveFolderId && await exists(a.driveFolderId)) return a.driveFolderId;
  if (a.driveFolderId) {
    // Folder was deleted on Drive: upload this auction again.
    a.csvDriveId = null; a.csvDirty = true;
    for (const l of await db.lots(a.id)) { (l.photos || []).forEach(p => { p.driveId = null; }); await db.putLot(l); }
  }
  let root = prefs.get("driveRoot", null);
  if (!root || !(await exists(root))) { root = await createFolder("Auction Camera", null); prefs.set("driveRoot", root); }
  a.driveFolderId = await createFolder(a.name, root);
  await db.putAuction(a);
  return a.driveFolderId;
}

export async function pendingCount() {
  let n = 0;
  for (const a of await db.allAuctions()) for (const l of await db.lots(a.id)) n += (l.photos || []).filter(p => !p.driveId).length;
  return n;
}

let running = false, again = false;
/** Runs the upload queue (safe to call often). */
export async function kick() {
  if (!driveOn()) { setState("Drive off", "idle"); return; }
  if (running) { again = true; return; }
  running = true;
  try {
    do { again = false; await pass(); } while (again);
  } catch (e) {
    if (e.signin) setState("Tap to reconnect Drive", "warn");
    else if (!navigator.onLine) setState("Offline — will upload later", "warn");
    else setState("Upload paused", "warn");
    console.warn(e);
  } finally { running = false; }
}

async function pass() {
  if (!validToken()) {
    // Try a silent refresh; if Google needs a tap, ask the user.
    try {
      await ensureClient();
      await new Promise((resolve, reject) => {
        pending = { resolve, reject };
        client.requestAccessToken({ prompt: "" });
        setTimeout(() => { if (pending) { pending = null; reject(Object.assign(new Error("signin"), { signin: true })); } }, 8000);
      });
    } catch { throw Object.assign(new Error("signin"), { signin: true }); }
  }
  for (const id of prefs.get("pendingDeletes", [])) {
    await remove(id);
    prefs.set("pendingDeletes", prefs.get("pendingDeletes", []).filter(x => x !== id));
  }
  let left = await pendingCount();
  for (const a of await db.allAuctions()) {
    const lots = (await db.lots(a.id)).sort((x, y) => x.number - y.number);
    const todo = lots.some(l => (l.photos || []).some(p => !p.driveId));
    if (!todo && !a.csvDirty) continue;
    const folder = await ensureFolder(a);
    for (const l0 of lots) {
      for (const p0 of l0.photos || []) {
        if (p0.driveId) continue;
        setState(`Uploading · ${left} left`, "busy");
        const blob = await db.getBlob(blobKey(a.id, p0.file));
        const fresh = await db.getLot(a.id, l0.number);
        const p = fresh && (fresh.photos || []).find(x => x.file === p0.file);
        if (!blob || !p) { left--; continue; }
        const id = await upload(folder, p.file, blob, "image/jpeg");
        const latest = await db.getLot(a.id, l0.number);
        const lp = latest && (latest.photos || []).find(x => x.file === p0.file);
        if (lp) { lp.driveId = id; await db.putLot(latest); } else prefs.set("pendingDeletes", [...prefs.get("pendingDeletes", []), id]);
        left--;
        listeners.forEach(f => f(state));
      }
    }
    const fa = await db.getAuction(a.id);
    if (fa && fa.csvDirty) await uploadCsv(fa, folder);
  }
  setState("All uploaded", "ok");
}

async function uploadCsv(a, folder) {
  const csv = buildCsv(await db.lots(a.id));
  const blob = new Blob([csv], { type: "text/csv" });
  if (a.csvDriveId) {
    try { await update(a.csvDriveId, blob, "text/csv"); } catch (e) { if (!e.notFound) throw e; a.csvDriveId = null; }
  }
  if (!a.csvDriveId) a.csvDriveId = await upload(folder, csvName(a), blob, "text/csv");
  const latest = await db.getAuction(a.id);
  latest.csvDriveId = a.csvDriveId;
  if (buildCsv(await db.lots(a.id)) === csv) latest.csvDirty = false;
  await db.putAuction(latest);
}

export function queueDelete(id) { if (id) prefs.set("pendingDeletes", [...prefs.get("pendingDeletes", []), id]); }

window.addEventListener("online", () => kick());
