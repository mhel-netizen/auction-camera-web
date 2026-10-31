// Local storage for auctions, lots and photos (IndexedDB). Everything stays on this device until uploaded.
const DB_NAME = "auction-camera";
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("auctions")) db.createObjectStore("auctions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("lots")) {
        const s = db.createObjectStore("lots", { keyPath: "key" });
        s.createIndex("auction", "auctionId");
      }
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const lotKey = (auctionId, n) => `${auctionId}#${n}`;
export const blobKey = (auctionId, file) => `${auctionId}/${file}`;

export const db = {
  allAuctions: () => tx("auctions", "readonly", s => req2p(s.getAll())),
  getAuction: id => tx("auctions", "readonly", s => req2p(s.get(id))),
  putAuction: a => tx("auctions", "readwrite", s => { s.put(a); }),
  lots: auctionId => tx("lots", "readonly", s => req2p(s.index("auction").getAll(auctionId))),
  getLot: (auctionId, n) => tx("lots", "readonly", s => req2p(s.get(lotKey(auctionId, n)))),
  putLot: lot => tx("lots", "readwrite", s => { lot.key = lotKey(lot.auctionId, lot.number); s.put(lot); }),
  deleteLot: lot => tx("lots", "readwrite", s => { s.delete(lot.key || lotKey(lot.auctionId, lot.number)); }),
  putBlob: (key, blob) => tx("blobs", "readwrite", s => { s.put(blob, key); }),
  getBlob: key => tx("blobs", "readonly", s => req2p(s.get(key))),
  deleteBlob: key => tx("blobs", "readwrite", s => { s.delete(key); }),
  async deleteAuction(a) {
    const lots = await this.lots(a.id);
    for (const l of lots) {
      for (const p of l.photos || []) await this.deleteBlob(blobKey(a.id, p.file));
      await this.deleteLot(l);
    }
    await tx("auctions", "readwrite", s => { s.delete(a.id); });
  },
};

// Simple settings store (localStorage, guarded).
export const prefs = {
  get(k, d) {
    try { const v = localStorage.getItem("ac:" + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem("ac:" + k, JSON.stringify(v)); } catch { /* storage full or blocked */ }
  },
};
