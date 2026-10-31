// Full-screen in-app camera for rapid shooting, and a barcode scanner.
import { grab, resize } from "./image.js";

const root = () => document.getElementById("overlay-root");
const el = (html) => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; };

async function startStream(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

/** Fallback: the phone's own camera / photo picker. */
function pickFiles({ capture, multiple }) {
  return new Promise(resolve => {
    const i = document.createElement("input");
    i.type = "file"; i.accept = "image/*"; if (capture) i.capture = "environment"; i.multiple = !!multiple;
    i.style.display = "none";
    i.onchange = () => { resolve([...i.files]); i.remove(); };
    document.body.appendChild(i);
    i.click();
  });
}
export { pickFiles };

/**
 * Opens the camera. Each shot is passed to onPhoto(blob). Resolves with the number of photos taken.
 */
export function openCamera({ lotNumber, onPhoto }) {
  return new Promise(async resolve => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const files = await pickFiles({ capture: true, multiple: true });
      for (const f of files) await onPhoto(await resize(f));
      return resolve(files.length);
    }
    const ui = el(`
      <div class="cam" role="dialog" aria-label="Camera">
        <div class="stage">
          <div class="top">
            <span class="tag small"><span class="tag-label">Lot</span><span class="tag-num">${lotNumber}</span></span>
            <button class="close" aria-label="Close camera">✕</button>
          </div>
          <video playsinline muted></video>
          <div class="flash"></div>
          <div class="hint">Take as many photos as you need, then tap Done</div>
        </div>
        <div class="bottom">
          <div class="last" aria-label="Photos taken"><b hidden>0</b></div>
          <button class="shutter" aria-label="Take photo"></button>
          <button class="done">Done</button>
        </div>
      </div>`);
    root().appendChild(ui);
    const video = ui.querySelector("video"), flash = ui.querySelector(".flash"), last = ui.querySelector(".last"), badge = last.querySelector("b");
    let stream = null, count = 0, busy = false;
    const finish = () => {
      if (stream) stream.getTracks().forEach(t => t.stop());
      ui.remove();
      document.removeEventListener("keydown", onKey);
      resolve(count);
    };
    const onKey = e => { if (e.key === "Escape") finish(); if (e.key === " " || e.key === "Enter") shoot(); };
    document.addEventListener("keydown", onKey);
    ui.querySelector(".close").onclick = finish;
    ui.querySelector(".done").onclick = finish;

    async function shoot() {
      if (busy || !video.videoWidth) return;
      busy = true;
      flash.classList.remove("go"); void flash.offsetWidth; flash.classList.add("go");
      if (navigator.vibrate) navigator.vibrate(15);
      try {
        const blob = await grab(video);
        const url = URL.createObjectURL(blob);
        // Fly the shot into the corner thumbnail.
        const fly = document.createElement("div");
        fly.className = "fly";
        const st = ui.querySelector(".stage").getBoundingClientRect(), lr = last.getBoundingClientRect();
        Object.assign(fly.style, { left: st.left + "px", top: st.top + "px", width: st.width + "px", height: st.height + "px", backgroundImage: `url(${url})` });
        ui.appendChild(fly);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          Object.assign(fly.style, { left: lr.left + "px", top: lr.top + "px", width: lr.width + "px", height: lr.height + "px", opacity: ".9" });
        }));
        setTimeout(() => { last.style.backgroundImage = `url(${url})`; fly.remove(); }, 460);
        count++;
        badge.hidden = false; badge.textContent = count;
        await onPhoto(blob);
      } finally { busy = false; }
    }
    ui.querySelector(".shutter").onclick = shoot;

    try {
      stream = await startStream(video);
    } catch (e) {
      // Camera blocked or unavailable: use the phone's camera app instead.
      ui.remove();
      document.removeEventListener("keydown", onKey);
      const files = await pickFiles({ capture: true, multiple: true });
      for (const f of files) await onPhoto(await resize(f));
      resolve(files.length);
    }
  });
}

async function detector() {
  const formats = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39"];
  if ("BarcodeDetector" in window) {
    try {
      const ok = await window.BarcodeDetector.getSupportedFormats();
      const use = formats.filter(f => ok.includes(f));
      if (use.length) return new window.BarcodeDetector({ formats: use });
    } catch { /* fall through to the add-on */ }
  }
  const urls = [
    "https://cdn.jsdelivr.net/npm/barcode-detector@2/dist/es/pure.min.js",
    "https://cdn.jsdelivr.net/npm/barcode-detector@2/+esm",
  ];
  for (const u of urls) {
    try {
      const m = await import(u);
      const BD = m.BarcodeDetector || (m.default && m.default.BarcodeDetector) || m.default;
      if (BD) return new BD({ formats });
    } catch { /* try next */ }
  }
  throw new Error("Barcode scanning isn't available in this browser");
}

/** Opens the barcode scanner. Resolves with the code text, or null if closed. */
export function openScanner() {
  return new Promise(async (resolve, reject) => {
    let det;
    try { det = await detector(); } catch (e) { return reject(e); }
    const ui = el(`
      <div class="cam" role="dialog" aria-label="Scan barcode">
        <div class="stage">
          <div class="top"><span style="font-weight:700">Scan barcode</span><button class="close" aria-label="Close">✕</button></div>
          <video playsinline muted></video>
          <div class="scanbox"></div><div class="scanline"></div>
          <div class="hint">Hold the barcode inside the box</div>
        </div>
        <div class="bottom" style="grid-template-columns:1fr"><span class="muted" style="text-align:center;color:#ffffffaa">UPC, EAN and most store barcodes</span></div>
      </div>`);
    root().appendChild(ui);
    const video = ui.querySelector("video");
    let stream = null, done = false;
    const finish = v => {
      if (done) return; done = true;
      if (stream) stream.getTracks().forEach(t => t.stop());
      ui.remove();
      resolve(v);
    };
    ui.querySelector(".close").onclick = () => finish(null);
    try { stream = await startStream(video); } catch { ui.remove(); return reject(new Error("Camera access was blocked")); }
    const loop = async () => {
      if (done) return;
      try {
        const codes = await det.detect(video);
        if (codes && codes.length && codes[0].rawValue) {
          if (navigator.vibrate) navigator.vibrate(40);
          return finish(codes[0].rawValue.trim());
        }
      } catch { /* frame not ready */ }
      setTimeout(loop, 180);
    };
    loop();
  });
}
