// Auction Camera — web app: routing, screens and lot logic.
import { db, prefs, blobKey } from "./db.js";
import { photoUrl, forgetUrl, resize } from "./image.js";
import { openCamera, openScanner, pickFiles } from "./camera.js";
import { identify, PROVIDERS, ai, testProvider } from "./ai.js";
import { buildCsv, csvName } from "./csv.js";
import { connectDrive, disconnectDrive, driveOn, driveState, onDrive, kick, pendingCount, queueDelete, clientId } from "./drive.js";

const CONDITIONS = ["USED", "LOOKS NEW", "UNTESTED", "TESTED", "WORKING", "NOT WORKING", "DAMAGED", "MIGHT MISSING PARTS", "SEALED"];
const view = document.getElementById("view");
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------------- Small UI helpers ----------------
export function toast(msg, ms = 2800) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 240); }, ms);
}

function sheet({ title, body, ok = "Save", cancel = "Cancel", danger = false, onOpen }) {
  return new Promise(resolve => {
    const s = document.createElement("div");
    s.className = "scrim";
    s.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2><div class="sheet-body">${body || ""}</div>
      <div class="actions">${cancel ? `<button class="btn" data-x>${esc(cancel)}</button>` : "<span></span>"}
      ${ok ? `<button class="btn ${danger ? "dark" : "primary"}" data-ok>${esc(ok)}</button>` : ""}</div></div>`;
    $("#overlay-root").appendChild(s);
    const close = v => { s.remove(); resolve(v); };
    s.addEventListener("click", e => { if (e.target === s) close(null); });
    s.querySelector("[data-x]")?.addEventListener("click", () => close(null));
    s.querySelector("[data-ok]")?.addEventListener("click", () => close(s));
    onOpen?.(s);
    s.querySelector("input,textarea,button[data-ok]")?.focus();
  });
}

function setBar(title, back) {
  $("#barTitle").textContent = title;
  const b = $("#back");
  b.hidden = !back;
  b.onclick = () => { location.hash = back; };
  $("#settingsLink").hidden = location.hash.startsWith("#/settings");
}

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------------- Sync indicator ----------------
async function paintSync(st = driveState()) {
  const dot = $("#syncDot"), txt = $("#syncText");
  if (!driveOn()) { dot.className = "sync-dot"; txt.textContent = navigator.onLine ? "Drive off" : "Offline"; return; }
  dot.className = "sync-dot " + ({ ok: "ok", busy: "busy", warn: "warn" }[st.kind] || "");
  txt.textContent = st.text;
}
onDrive(st => { paintSync(st); if (current.refresh) current.refresh(); });
$("#sync").onclick = async () => {
  if (!driveOn() || driveState().kind === "warn") {
    try { await connectDrive(); toast("Google Drive connected"); } catch (e) { toast(e.message); location.hash = "#/settings"; }
  } else {
    const n = await pendingCount();
    toast(n ? `${n} photos waiting to upload` : "Everything is in Google Drive");
  }
};
window.addEventListener("online", () => paintSync());
window.addEventListener("offline", () => paintSync());

// ---------------- Data helpers ----------------
async function markDirty(auctionId) {
  const a = await db.getAuction(auctionId);
  if (a && !a.csvDirty) { a.csvDirty = true; await db.putAuction(a); }
}

async function newLot(a) {
  const lots = await db.lots(a.id);
  const n = lots.length ? Math.max(...lots.map(l => l.number)) + 1 : a.startLot;
  const lot = { auctionId: a.id, number: n, title: "", description: "", autoDescription: "", reserve: "", startBid: "", barcode: "", productInfo: "", nextPhoto: 5, photos: [], created: Date.now() };
  await db.putLot(lot);
  return lot;
}

const reserved = new Set();
/** Stock photos take free slots 1–4; camera photos start at 5. */
function newPhotoName(lot, stock) {
  const used = new Set(lot.photos.map(p => p.idx));
  if (stock) {
    for (let i = 1; i <= 4; i++) {
      const k = `${lot.auctionId}#${lot.number}-${i}`;
      if (!used.has(i) && !reserved.has(k)) { reserved.add(k); return { file: `${lot.number}-${i}.jpg`, idx: i }; }
    }
  }
  if (!lot.nextPhoto || lot.nextPhoto < 5) lot.nextPhoto = 5;
  while (used.has(lot.nextPhoto)) lot.nextPhoto++;
  const idx = lot.nextPhoto++;
  return { file: `${lot.number}-${idx}.jpg`, idx };
}

/** Serialises lot writes so fast camera shots never overwrite each other. */
let chain = Promise.resolve();
function withLot(auctionId, n, fn) {
  const run = chain.then(async () => {
    const lot = await db.getLot(auctionId, n);
    if (!lot) return null;
    const r = await fn(lot);
    await db.putLot(lot);
    return r ?? lot;
  });
  chain = run.catch(() => {});
  return run;
}

async function addPhoto(auctionId, n, blob, stock) {
  return withLot(auctionId, n, async lot => {
    const { file, idx } = newPhotoName(lot, stock);
    await db.putBlob(blobKey(auctionId, file), blob);
    reserved.delete(`${auctionId}#${n}-${idx}`);
    lot.photos.push({ file, idx, stock: !!stock, driveId: null });
    lot.photos.sort((x, y) => x.idx - y.idx);
  }).then(r => { markDirty(auctionId); kick(); return r; });
}

async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* not supported */ }
}

// ---------------- Router ----------------
let current = {};
const depth = h => (h.startsWith("#/settings") ? 1 : (h.match(/\//g) || []).length);
let lastHash = "";

async function route() {
  const h = location.hash || "#/";
  if (current.leave) { try { await current.leave(); } catch { /* ignore */ } }
  current = {};
  const back = depth(h) < depth(lastHash);
  lastHash = h;
  view.classList.remove("enter", "enter-back"); void view.offsetWidth;
  view.classList.add(back ? "enter-back" : "enter");
  window.scrollTo(0, 0);
  const [path, query] = h.slice(1).split("?");
  const parts = path.split("/").filter(Boolean);
  try {
    if (parts[0] === "settings") await settingsView();
    else if (parts[0] === "a" && parts[2] === "lot") await lotView(parts[1], Number(parts[3]), new URLSearchParams(query || ""));
    else if (parts[0] === "a") await auctionView(parts[1]);
    else await homeView();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a class="btn primary" href="#/">Go to auctions</a></div>`;
  }
  paintSync();
}
window.addEventListener("hashchange", route);

// ---------------- Home: auctions ----------------
async function homeView() {
  setBar("Auction Camera", null);
  const auctions = (await db.allAuctions()).sort((a, b) => b.created - a.created);
  const cards = [];
  for (const a of auctions) {
    const lots = await db.lots(a.id);
    const first = lots.sort((x, y) => x.number - y.number).find(l => l.photos?.length);
    const cover = first ? await photoUrl(a.id, (first.photos.find(p => !p.stock) || first.photos[0]).file) : "";
    const waiting = lots.reduce((s, l) => s + (l.photos || []).filter(p => !p.driveId).length, 0);
    cards.push(`<a class="auction" href="#/a/${a.id}">
      <div class="cover" style="${cover ? `background-image:url(${cover})` : ""}"></div>
      <div class="grow"><div class="name">${esc(a.name)}</div>
        <div class="meta">${new Date(a.created).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}${driveOn() ? (waiting ? ` · ${waiting} to upload` : " · in Drive") : ""}</div></div>
      <div class="count">${lots.length}<small>lots</small></div></a>`);
  }
  view.innerHTML = `
    <div class="home-head"><div><h1>Auctions</h1><p class="muted">Each auction gets its own Drive folder and AuctionFlex CSV.</p></div>
      <button class="btn primary" id="newAuction"><svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>New auction</button></div>
    ${auctions.length ? `<div class="auction-list">${cards.join("")}</div>` : `
      <div class="empty">
        <span class="tag big swing"><span class="tag-label">Lot</span><span class="tag-num">1</span></span>
        <h2>Start your first auction</h2>
        <p>Photograph each lot, let AI write the title and description, and export a catalog ready for AuctionFlex.</p>
        <button class="btn primary" id="newAuction2">Create an auction</button>
      </div>`}`;
  const create = async () => {
    const today = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const s = await sheet({
      title: "New auction", ok: "Create auction",
      body: `<label class="field"><span class="field-label">Auction name</span><input class="input" id="an" value="Auction ${esc(today)}"></label>
             <label class="field"><span class="field-label">First lot number</span><input class="input" id="al" inputmode="numeric" value="1"></label>`,
      onOpen: s => setTimeout(() => s.querySelector("#an").select(), 50),
    });
    if (!s) return;
    const a = { id: uid(), name: s.querySelector("#an").value.trim() || "Auction", startLot: parseInt(s.querySelector("#al").value, 10) || 1, created: Date.now(), csvDirty: true };
    await db.putAuction(a);
    requestPersist();
    kick();
    location.hash = `#/a/${a.id}`;
  };
  $("#newAuction")?.addEventListener("click", create);
  $("#newAuction2")?.addEventListener("click", create);
}

// ---------------- Auction: lots ----------------
async function auctionView(id) {
  const a = await db.getAuction(id);
  if (!a) { location.hash = "#/"; return; }
  setBar(a.name, "#/");
  const paint = async () => {
    const lots = (await db.lots(id)).sort((x, y) => y.number - x.number);
    const photos = lots.reduce((s, l) => s + (l.photos || []).length, 0);
    const waiting = lots.reduce((s, l) => s + (l.photos || []).filter(p => !p.driveId).length, 0);
    const rows = [];
    for (const l of lots) {
      const ph = (l.photos || []).find(p => !p.stock) || (l.photos || [])[0];
      const u = ph ? await photoUrl(id, ph.file) : "";
      const w = (l.photos || []).filter(p => !p.driveId).length;
      const up = !driveOn() || !l.photos?.length ? "" : w ? `<span class="pill up">↑ ${w} waiting</span>` : `<span class="pill ok">✓ in Drive</span>`;
      const money = [l.reserve && `Res $${esc(l.reserve)}`, l.startBid && `Start $${esc(l.startBid)}`].filter(Boolean).join("<br>");
      rows.push(`<a class="lot-row" href="#/a/${id}/lot/${l.number}">
        <div class="thumb" style="${u ? `background-image:url(${u})` : ""}"></div>
        <div style="min-width:0"><div class="t ${l.title ? "" : "none"}">${esc(l.title || "No title yet")}</div>
          <div class="m"><span class="tag small"><span class="tag-num">${l.number}</span></span><span>${(l.photos || []).length} photos</span>${up}</div></div>
        <div class="money">${money}</div></a>`);
    }
    view.innerHTML = `
      <div class="auction-head">
        <div class="stats"><div class="stat"><b>${lots.length}</b><span>Lots</span></div><div class="stat"><b>${photos}</b><span>Photos</span></div>${driveOn() ? `<div class="stat"><b>${waiting}</b><span>To upload</span></div>` : ""}</div>
      </div>
      <div class="toolbar">
        <button class="btn" id="csv">Download CSV</button>
        <button class="btn" id="zip">Download ZIP</button>
        <button class="btn" id="up">${driveOn() ? "Upload now" : "Connect Drive"}</button>
        <button class="btn ghost" id="more" aria-label="Auction options">•••</button>
      </div>
      ${lots.length ? `<div class="lots">${rows.join("")}</div>` : `
        <div class="empty"><span class="tag big swing"><span class="tag-label">Lot</span><span class="tag-num">${a.startLot}</span></span>
        <h2>No lots yet</h2><p>Tap New lot. The camera opens — take a few photos of the item, then tap Done.</p></div>`}
      <button class="fab" id="newLot"><svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.4" fill="none" stroke="currentColor" stroke-width="2"/></svg>New lot</button>`;
    $("#newLot").onclick = async () => { const l = await newLot(a); location.hash = `#/a/${id}/lot/${l.number}?camera=1`; };
    $("#csv").onclick = async () => download(csvName(a), new Blob([buildCsv(await db.lots(id))], { type: "text/csv" }));
    $("#zip").onclick = async e => {
      if (!window.JSZip) return toast("ZIP needs an internet connection the first time");
      const b = e.currentTarget; b.disabled = true; b.innerHTML = `<span class="spin"></span>Preparing…`;
      try {
        const zip = new JSZip();
        const all = await db.lots(id);
        zip.file(csvName(a), buildCsv(all));
        for (const l of all) for (const p of l.photos || []) { const bl = await db.getBlob(blobKey(id, p.file)); if (bl) zip.file(p.file, bl); }
        download(csvName(a).replace(" - lots.csv", ".zip"), await zip.generateAsync({ type: "blob" }));
      } finally { b.disabled = false; b.textContent = "Download ZIP"; }
    };
    $("#up").onclick = async () => {
      try { await connectDrive(); toast("Uploading to Google Drive"); } catch (e) { toast(e.message); }
    };
    $("#more").onclick = async () => {
      const s = await sheet({
        title: a.name, ok: "Save name", cancel: "Close",
        body: `<label class="field"><span class="field-label">Auction name</span><input class="input" id="rn" value="${esc(a.name)}"></label>
               <button class="btn danger block" id="del" style="margin-top:16px">Delete auction from this device</button>
               <p class="small muted">Photos already in Google Drive stay there.</p>`,
        onOpen: s => s.querySelector("#del").onclick = async () => {
          if (confirmDelete()) { s.remove(); await db.deleteAuction(a); toast("Auction deleted"); location.hash = "#/"; }
        },
      });
      if (s) { a.name = s.querySelector("#rn").value.trim() || a.name; await db.putAuction(a); setBar(a.name, "#/"); }
    };
  };
  const confirmDelete = () => window.confirm("Delete this auction and its photos from this device?");
  const me = current;
  current.refresh = () => { clearTimeout(me._t); me._t = setTimeout(() => { if (current === me) paint(); }, 300); };
  await paint();
}

// ---------------- Lot screen ----------------
async function lotView(auctionId, n, q) {
  const a = await db.getAuction(auctionId);
  let lot = await db.getLot(auctionId, n);
  if (!a || !lot) { location.hash = a ? `#/a/${auctionId}` : "#/"; return; }
  setBar(`Lot ${n}`, `#/a/${auctionId}`);

  view.innerHTML = `
    <div class="lot-layout">
      <div class="panel">
        <div class="lot-top">
          <span class="tag big swing"><span class="tag-label">Lot</span><span class="tag-num">${n}</span></span>
          <span class="small muted" id="pcount"></span>
        </div>
        <div class="strip" id="strip"></div>
        <div class="tools">
          <button class="btn primary" id="cam"><svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.4" fill="none" stroke="currentColor" stroke-width="2"/></svg>Take photos</button>
          <button class="btn" id="stock">My stock photo</button>
          <button class="btn" id="ai">✦ Identify (AI)</button>
          <button class="btn" id="scan">Scan barcode</button>
        </div>
        <div class="status" id="status"></div>
        <div id="product"></div>
      </div>
      <div class="panel lot-side">
        <label class="field"><span class="field-label">Title <small id="cnt">0/50</small></span>
          <input class="input title-input" id="title" maxlength="50" autocomplete="off" placeholder="What is it?"></label>
        <div class="money-row">
          <label><span class="field-label">Reserve</span><div class="money-input"><span>$</span><input class="input" id="reserve" inputmode="decimal" placeholder="0.00"></div></label>
          <label><span class="field-label">Start Bid</span><div class="money-input"><span>$</span><input class="input" id="startBid" inputmode="decimal" placeholder="0.00"></div></label>
        </div>
        <div class="field" style="margin-top:14px"><span class="field-label">Condition <small>tap to add or remove</small></span>
          <div class="chips" id="chips">${CONDITIONS.map(c => `<button class="chip" data-c="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join("")}</div></div>
        <label class="field"><span class="field-label">Description <small>your text is kept · AI adds below</small></span>
          <textarea class="textarea" id="desc" placeholder="e.g. Tested, works. Small scratch on back."></textarea></label>
        <button class="btn ghost block" id="online" style="margin-top:10px">Find this product online</button>
      </div>
    </div>
    <div class="savebar"><div class="inner">
      <button class="btn" id="done">Done</button>
      <button class="btn dark" id="next">Save &amp; next lot</button>
    </div></div>`;

  const titleEl = $("#title"), descEl = $("#desc"), resEl = $("#reserve"), bidEl = $("#startBid"), status = $("#status");
  titleEl.value = lot.title || ""; descEl.value = lot.description || ""; resEl.value = lot.reserve || ""; bidEl.value = lot.startBid || "";
  const count = () => { $("#cnt").textContent = `${titleEl.value.length}/50`; };
  count();

  // --- description: user's part is kept, AI part sits below and is replaced on re-run ---
  const userPart = () => {
    const cur = descEl.value, old = (lot.autoDescription || "").trim();
    if (!old) return cur.trim();
    if (cur.trimEnd().endsWith(old)) return cur.trimEnd().slice(0, -old.length).trim();
    if (cur.includes(old)) return cur.replace(old, "").trim();
    return cur.trim();
  };
  const tokens = () => userPart().split(",").map(s => s.trim()).filter(Boolean);
  const paintChips = () => {
    const t = tokens().map(x => x.toUpperCase());
    document.querySelectorAll(".chip").forEach(c => { const on = t.includes(c.dataset.c); c.classList.toggle("on", on); c.setAttribute("aria-pressed", on); });
  };
  const compose = (user, auto) => [user.trim(), (auto || "").trim()].filter(Boolean).join("\n\n");

  let saveT = null;
  const save = async () => {
    clearTimeout(saveT);
    await withLot(auctionId, n, l => {
      l.title = titleEl.value.trim(); l.description = descEl.value.trim();
      l.reserve = resEl.value.trim(); l.startBid = bidEl.value.trim();
      l.autoDescription = lot.autoDescription || ""; l.barcode = lot.barcode || ""; l.productInfo = lot.productInfo || "";
    });
    await markDirty(auctionId);
    kick();
  };
  const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(save, 450); };
  [titleEl, descEl, resEl, bidEl].forEach(el => el.addEventListener("input", saveSoon));
  titleEl.addEventListener("input", count);
  descEl.addEventListener("input", paintChips);
  paintChips();

  const setAuto = auto => {
    const user = userPart();
    lot.autoDescription = (auto || "").trim();
    descEl.value = compose(user, lot.autoDescription);
    flash(descEl);
    paintChips();
    save();
  };
  const flash = el => { el.classList.remove("flash-fill"); void el.offsetWidth; el.classList.add("flash-fill"); };

  $("#chips").addEventListener("click", e => {
    const c = e.target.closest(".chip"); if (!c) return;
    const word = c.dataset.c, user = userPart();
    const parts = user.split(",").map(s => s.trim()).filter(Boolean);
    const i = parts.findIndex(p => p.toUpperCase() === word);
    let nu;
    if (i >= 0) { parts.splice(i, 1); nu = parts.join(", "); }
    else nu = user ? user.replace(/[,\s]+$/, "") + ", " + word : word;
    descEl.value = compose(nu, lot.autoDescription);
    paintChips();
    save();
  });

  // --- photos ---
  const strip = $("#strip");
  let newest = null;
  const paintPhotos = async () => {
    if (!strip.isConnected) return;
    lot = await db.getLot(auctionId, n) || lot;
    if (!strip.isConnected) return;
    const ph = lot.photos || [];
    $("#pcount").textContent = ph.length ? `${ph.length} photo${ph.length > 1 ? "s" : ""}` : "";
    const items = [];
    for (const p of ph) items.push(await tile(p));
    if (!ph.some(p => p.idx > 4)) items.push(`<button class="ph slot" data-cam title="Take photos">Photo ${lot.number}-5<br>+</button>`);
    const stockCount = ph.filter(p => p.idx <= 4).length;
    if (stockCount < 4) items.push(`<button class="ph slot" data-slot="1" title="Add stock photo">Stock photo<br>slots 1–4<br>+</button>`);
    strip.innerHTML = items.join("");
  };
  const tile = async p => {
    const u = await photoUrl(auctionId, p.file);
    return `<button class="ph${p.file === newest ? " new" : ""}" data-file="${esc(p.file)}" style="background-image:url(${u})" aria-label="Photo ${esc(p.file)}">
      <span class="n">${p.idx}</span>${p.stock ? `<span class="stk">STOCK</span>` : ""}${driveOn() ? `<span class="s">${p.driveId ? "✓" : "↑"}</span>` : ""}</button>`;
  };
  strip.addEventListener("click", async e => {
    const b = e.target.closest(".ph"); if (!b) return;
    if (b.dataset.slot) return addStock();
    if (b.dataset.cam !== undefined) return shoot();
    const p = lot.photos.find(x => x.file === b.dataset.file);
    if (!p) return;
    const u = await photoUrl(auctionId, p.file);
    const s = await sheet({ title: p.file, ok: "Delete photo", cancel: "Close", danger: true, body: `<div class="viewer"><img src="${u}" alt=""></div>` });
    if (s) {
      await withLot(auctionId, n, l => { l.photos = l.photos.filter(x => x.file !== p.file); });
      await db.deleteBlob(blobKey(auctionId, p.file));
      forgetUrl(auctionId, p.file);
      queueDelete(p.driveId);
      kick();
      paintPhotos();
      toast("Photo deleted");
    }
  });

  let shot = 0;
  const shoot = async () => {
    const before = (lot.photos || []).filter(p => !p.stock).length;
    const taken = await openCamera({
      lotNumber: n,
      onPhoto: async blob => { const l = await addPhoto(auctionId, n, blob, false); newest = l?.photos?.[l.photos.length - 1]?.file; shot++; },
    });
    await chain;
    await paintPhotos();
    if (taken && !before && !titleEl.value && prefs.get("autoIdentify", true) && ai.anyAvailable()) runAI();
  };
  const addStock = async () => {
    const files = await pickFiles({ capture: false, multiple: true });
    for (const f of files) { const l = await addPhoto(auctionId, n, await resize(f), true); newest = l?.photos?.find(p => p.stock && !p.driveId)?.file; }
    await paintPhotos();
  };
  $("#cam").onclick = shoot;
  $("#stock").onclick = addStock;

  // --- AI ---
  const aiBtn = $("#ai");
  const runAI = async () => {
    if (!ai.anyAvailable()) { toast("Add an AI key in Settings first — Gemini is free"); return; }
    lot = await db.getLot(auctionId, n);
    const real = lot.photos.filter(p => !p.stock);
    const use = (real.length ? real : lot.photos).slice(0, 5);
    if (!use.length) { toast("Take a photo first"); return; }
    aiBtn.disabled = true;
    status.className = "status";
    status.innerHTML = `<span class="thinking"><i></i><i></i><i></i></span>Identifying${prefs.get("webSpecs", true) ? " and checking specs online" : ""}…`;
    try {
      const blobs = [];
      for (const p of use) { const b = await db.getBlob(blobKey(auctionId, p.file)); if (b) blobs.push(b); }
      const notes = [userPart(), lot.productInfo && `Barcode lookup says this exact product is: ${lot.productInfo}`, lot.barcode && !lot.productInfo && `Barcode: ${lot.barcode}`].filter(Boolean).join("\n");
      const r = await identify(blobs, notes);
      titleEl.value = r.title; count(); flash(titleEl);
      const src = r.source && !r.description.includes(r.source) ? ` Source: ${r.source}` : "";
      setAuto(r.description + src);
      status.className = "status good";
      status.textContent = r.confidence === "low" ? `${r.provider} isn't sure — check the title and description.` : `Identified by ${r.provider}. Edit anything that's off.`;
      if (r.confidence === "low") status.className = "status";
    } catch (e) {
      status.className = "status err";
      status.textContent = "AI couldn't identify this lot:\n" + e.message;
    } finally { aiBtn.disabled = false; }
  };
  aiBtn.onclick = runAI;

  // --- barcode ---
  const paintProduct = links => {
    const box = $("#product");
    if (!lot.barcode) { box.innerHTML = ""; return; }
    const q = encodeURIComponent(lot.productInfo || lot.barcode);
    box.innerHTML = `<div class="product"><b>Barcode ${esc(lot.barcode)}</b>${lot.productInfo ? `<br>${esc(lot.productInfo)}` : ""}
      ${(links || []).map(([m, u]) => `<br><a href="${esc(u)}" target="_blank" rel="noopener">${esc(m)}</a>`).join("")}
      <br><a href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">Search Google</a></div>`;
  };
  paintProduct();
  $("#scan").onclick = async () => {
    let code;
    try { code = await openScanner(); } catch (e) { return toast(e.message); }
    if (!code) return;
    lot.barcode = code; lot.productInfo = "";
    paintProduct(); save();
    status.className = "status"; status.innerHTML = `<span class="thinking"><i></i><i></i><i></i></span>Looking up barcode ${esc(code)}…`;
    let links = [];
    try {
      const r = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`);
      if (r.ok) {
        const it = ((await r.json()).items || [])[0];
        if (it) {
          lot.productInfo = [it.brand && `Brand: ${it.brand}`, it.title && `Product: ${it.title}`, it.model && `Model: ${it.model}`].filter(Boolean).join(" · ");
          links = (it.offers || []).slice(0, 3).filter(o => /^https?:/.test(o.link)).map(o => [o.merchant || "Store", o.link]);
        }
      }
    } catch { /* lookup blocked or offline — the AI can still use the number */ }
    paintProduct(links); save();
    status.textContent = lot.productInfo ? "Product found." : "Product not in the free database — the AI will search for the barcode.";
    if (ai.anyAvailable()) runAI();
  };

  $("#online").onclick = () => {
    const qy = lot.productInfo || titleEl.value || lot.barcode;
    if (!qy) return toast("Identify the item or type a title first");
    window.open(`https://www.google.com/search?tbm=shop&q=${encodeURIComponent(qy)}`, "_blank", "noopener");
  };

  // --- leave / next ---
  $("#done").onclick = async () => { await save(); location.hash = `#/a/${auctionId}`; };
  $("#next").onclick = async () => {
    await save();
    const l = await newLot(a);
    location.hash = `#/a/${auctionId}/lot/${l.number}?camera=1`;
  };
  current.leave = async () => {
    await save();
    const l = await db.getLot(auctionId, n);
    if (l && !l.photos.length && !l.title && !l.description) await db.deleteLot(l); // keeps lot numbers without gaps
  };
  current.refresh = () => { clearTimeout(current._t); current._t = setTimeout(paintPhotos, 400); };

  await paintPhotos();
  if (q.get("camera") === "1") {
    history.replaceState(null, "", `#/a/${auctionId}/lot/${n}`);
    lastHash = location.hash;
    shoot();
  }
}

// ---------------- Settings ----------------
async function settingsView() {
  setBar("Settings", "#/");
  const chosen = ai.chosen();
  const lang = prefs.get("language", "English");
  view.innerHTML = `<div class="settings">
    <section><h2>AI that writes your titles</h2>
      <p class="help">Pick your main AI. Set up as many as you like — if one runs out of free requests, the next one takes over.</p>
      <div class="panel" style="padding:4px">${PROVIDERS.map(p => `
        <label class="opt"><input type="radio" name="prov" value="${p.id}" ${p.id === chosen.id ? "checked" : ""}>
          <div><b>${esc(p.name)}</b><span>${esc(p.note)}</span></div></label>`).join("")}</div>
    </section>
    <section class="panel">
      <label class="opt"><input type="checkbox" id="fallback" ${prefs.get("fallback", true) ? "checked" : ""}><div><b>Automatic fallback</b><span>Try the next AI if one fails or runs out</span></div></label>
      <label class="opt"><input type="checkbox" id="webSpecs" ${prefs.get("webSpecs", true) ? "checked" : ""}><div><b>Search online for exact specs</b><span>Gemini and Claude look up the exact model, e.g. “iPhone 15 Noir 128 Go”, and note the source</span></div></label>
      <label class="opt"><input type="checkbox" id="autoId" ${prefs.get("autoIdentify", true) ? "checked" : ""}><div><b>Identify automatically</b><span>Run the AI when you finish taking photos of a new lot</span></div></label>
      <div class="opt" style="align-items:center"><div class="grow"><b>Catalog language</b><span>Titles and descriptions</span></div>
        <div class="seg" id="lang"><button data-l="English" class="${lang === "English" ? "on" : ""}">English</button><button data-l="French" class="${lang === "French" ? "on" : ""}">Français</button></div></div>
    </section>
    <section><h2>AI keys</h2><p class="help">Keys are stored only in this browser on this device.</p>
      <div class="panel" style="padding:4px 12px">${PROVIDERS.map(p => `
        <details class="prov" data-id="${p.id}"><summary><span class="set-dot ${ai.available(p) ? "on" : ""}"></span>${esc(p.name)}<svg class="chev" width="16" height="16" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/></svg></summary>
          <div class="body stack">
            ${p.keyUrl ? `<p class="small muted" style="margin:0">Get a key: <a href="${p.keyUrl}" target="_blank" rel="noopener">${esc(p.keyUrl.replace(/^https:\/\//, ""))}</a></p>` : ""}
            ${p.keyOptional ? `<label class="row small"><input type="checkbox" data-enable ${prefs.get("enabled_" + p.id, false) ? "checked" : ""}> Use without a key</label>` : ""}
            ${p.id === "custom" ? `<input class="input" data-base placeholder="https://api.example.com/v1" value="${esc(prefs.get("customBase", ""))}">` : ""}
            <input class="input" data-key type="password" autocomplete="off" placeholder="API key" value="${esc(ai.key(p.id))}">
            <div class="row"><input class="input grow" data-model placeholder="${esc(p.model || "model name")}" value="${esc(ai.model(p))}" style="font-size:14px">
              ${p.model ? `<button class="btn" data-reset>Reset</button>` : ""}</div>
            <div class="row"><button class="btn" data-test>Test</button><span class="small muted grow" data-out></span></div>
          </div></details>`).join("")}</div>
      <p class="help" style="margin-top:10px">GitHub Models, NVIDIA, Cohere and Hugging Face block web apps, so they're only in the Android app.</p>
    </section>
    <section><h2>Google Drive</h2>
      <p class="help">Photos upload to the “Auction Camera” folder in your Drive, one folder per auction, named by lot number. The CSV sits in the same folder.</p>
      <div class="panel stack">
        <div class="row"><span class="set-dot ${driveOn() ? "on" : ""}"></span><b class="grow">${driveOn() ? "Connected" : "Not connected"}</b>
          <button class="btn ${driveOn() ? "" : "primary"}" id="drive">${driveOn() ? "Disconnect" : "Connect Google Drive"}</button></div>
        <details><summary class="small muted" style="cursor:pointer">Advanced: Google Client ID</summary>
          <input class="input" id="cid" style="margin-top:8px;font-size:14px" placeholder="….apps.googleusercontent.com" value="${esc(prefs.get("clientId", "") || clientId())}"></details>
      </div></section>
    <section><h2>This device</h2><div class="panel small muted" id="storage">Checking storage…</div></section>
  </div>`;

  view.querySelectorAll('input[name="prov"]').forEach(r => r.addEventListener("change", () => { prefs.set("provider", r.value); toast(`${PROVIDERS.find(p => p.id === r.value).name} is now your main AI`); }));
  $("#fallback").onchange = e => prefs.set("fallback", e.target.checked);
  $("#webSpecs").onchange = e => prefs.set("webSpecs", e.target.checked);
  $("#autoId").onchange = e => prefs.set("autoIdentify", e.target.checked);
  $("#lang").onclick = e => { const b = e.target.closest("button"); if (!b) return; prefs.set("language", b.dataset.l); $("#lang").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); };
  view.querySelectorAll("details.prov").forEach(d => {
    const p = PROVIDERS.find(x => x.id === d.dataset.id);
    const dot = d.querySelector(".set-dot");
    const sync = () => {
      prefs.set("key_" + p.id, d.querySelector("[data-key]").value.trim());
      prefs.set("model_" + p.id, d.querySelector("[data-model]").value.trim() || p.model);
      const en = d.querySelector("[data-enable]"); if (en) prefs.set("enabled_" + p.id, en.checked);
      const base = d.querySelector("[data-base]"); if (base) prefs.set("customBase", base.value.trim());
      dot.classList.toggle("on", ai.available(p));
    };
    d.querySelectorAll("input").forEach(i => i.addEventListener("change", sync));
    d.querySelector("[data-reset]")?.addEventListener("click", () => { d.querySelector("[data-model]").value = p.model; sync(); });
    d.querySelector("[data-test]").addEventListener("click", async e => {
      sync();
      const out = d.querySelector("[data-out]"), b = e.currentTarget;
      if (!ai.available(p)) { out.textContent = "Enter a key first"; return; }
      b.disabled = true; out.textContent = "Testing…";
      try { const r = await testProvider(p); d.querySelector("[data-model]").value = ai.model(p); out.innerHTML = `<span style="color:var(--ok)">Works with ${esc(r.model)}</span>`; }
      catch (err) { out.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
      finally { b.disabled = false; }
    });
  });
  $("#cid").onchange = e => prefs.set("clientId", e.target.value.trim());
  $("#drive").onclick = async () => {
    if (driveOn()) { disconnectDrive(); toast("Google Drive disconnected"); return settingsView(); }
    prefs.set("clientId", $("#cid").value.trim());
    try { await connectDrive(); toast("Google Drive connected"); settingsView(); } catch (e) { toast(e.message, 4500); }
  };
  try {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $("#storage").textContent = est ? `Using ${(est.usage / 1048576).toFixed(1)} MB of photos and data on this device.${persisted ? " Storage is protected from automatic clearing." : " Keep Drive connected so photos are backed up."}` : "Storage details aren't available in this browser.";
  } catch { $("#storage").textContent = ""; }
}

// ---------------- Start ----------------
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
route();
kick();
