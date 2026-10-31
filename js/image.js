// Image helpers: resize to web-ready JPEGs, fix rotation, make thumbnails.
import { db, blobKey } from "./db.js";

async function toBitmap(src) {
  if ("createImageBitmap" in window) {
    try { return await createImageBitmap(src, { imageOrientation: "from-image" }); } catch { /* fall through */ }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(src);
  });
}

/** Shrinks so the long side is at most maxSide; returns a JPEG Blob. */
export async function resize(src, maxSide = 1600, quality = 0.85) {
  const bmp = await toBitmap(src);
  const w = bmp.width, h = bmp.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return await new Promise(res => c.toBlob(res, "image/jpeg", quality));
}

/** Frame from a <video> as a JPEG Blob. */
export async function grab(video, maxSide = 1600, quality = 0.85) {
  const w = video.videoWidth, h = video.videoHeight;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  return await new Promise(res => c.toBlob(res, "image/jpeg", quality));
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

const urls = new Map();
/** Object URL for a stored photo (cached). */
export async function photoUrl(auctionId, file) {
  const k = blobKey(auctionId, file);
  if (urls.has(k)) return urls.get(k);
  const b = await db.getBlob(k);
  if (!b) return "";
  const u = URL.createObjectURL(b);
  urls.set(k, u);
  return u;
}
export function forgetUrl(auctionId, file) {
  const k = blobKey(auctionId, file);
  const u = urls.get(k);
  if (u) { URL.revokeObjectURL(u); urls.delete(k); }
}
