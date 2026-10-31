// AI identification: writes the title + description from a lot's photos.
import { prefs } from "./db.js";
import { blobToBase64, resize } from "./image.js";

export const PROVIDERS = [
  { id: "gemini", name: "Google Gemini", note: "Free tier · searches the web for exact specs", keyUrl: "https://aistudio.google.com/app/apikey", model: "gemini-3.8-flash", kind: "gemini", max: 5 },
  { id: "groq", name: "Groq", note: "Free tier · very fast · up to 3 photos", keyUrl: "https://console.groq.com/keys", model: "qwen/qwen3.8-27b", kind: "openai", base: "https://api.groq.com/openai/v1", max: 3 },
  { id: "openrouter", name: "OpenRouter", note: "Free “:free” models · quality varies", keyUrl: "https://openrouter.ai/keys", model: "google/gemma-3-27b-it:free", kind: "openai", base: "https://openrouter.ai/api/v1", max: 4 },
  { id: "mistral", name: "Mistral", note: "Free plan (phone verification)", keyUrl: "https://console.mistral.ai/api-keys", model: "mistral-medium-latest", kind: "openai", base: "https://api.mistral.ai/v1", max: 4, urlAsString: true },
  { id: "pollinations", name: "Pollinations", note: "No key needed · slow, last resort", keyUrl: "https://enter.pollinations.ai", model: "openai", kind: "openai", base: "https://gen.pollinations.ai/v1", max: 3, keyOptional: true },
  { id: "claude", name: "Anthropic Claude", note: "Paid · Haiku ≈ $0.001 per lot · web search", keyUrl: "https://console.anthropic.com/settings/keys", model: "claude-haiku-5-5", kind: "claude", max: 5 },
  { id: "openai", name: "OpenAI", note: "Paid", keyUrl: "https://platform.openai.com/api-keys", model: "gpt-5-mini", kind: "openai", base: "https://api.openai.com/v1", max: 5 },
  { id: "custom", name: "Custom (OpenAI-compatible)", note: "Any service with an OpenAI-style API", keyUrl: "", model: "", kind: "openai", base: "", max: 4 },
];
const RETIRED = { groq: ["meta-llama/llama-4-scout-17b-16e-instruct"] };

export const ai = {
  key: id => prefs.get("key_" + id, ""),
  model: p => prefs.get("model_" + p.id, p.model) || p.model,
  base: p => (p.id === "custom" ? prefs.get("customBase", "") : p.base).replace(/\/+$/, ""),
  available(p) {
    if (p.id === "custom" && !prefs.get("customBase", "")) return false;
    return !!this.key(p.id) || (p.keyOptional && prefs.get("enabled_" + p.id, false));
  },
  anyAvailable() { return PROVIDERS.some(p => this.available(p)); },
  chosen() { return PROVIDERS.find(p => p.id === prefs.get("provider", "gemini")) || PROVIDERS[0]; },
};

class ModelGone extends Error {}

function prompt(notes, search) {
  const lang = prefs.get("language", "English");
  return `You are cataloging items for an auction house. The photos show ONE auction lot.
${search ? "First identify the item from the photos, then use web search to find this exact product and its specifications." : "Identify the item from the photos."}

Respond with ONLY a JSON object, no other text:
{"title": "...", "description": "...", "confidence": "high" | "medium" | "low", "source": "..."}

Rules:
- Write the title and description in ${lang}.
- title: at most 50 characters. Exact product name first: brand, model, then the key variant such as colour and storage or size (for example "iPhone 15 Noir 128 Go" or "Apple iPhone 15 Black 128GB"). Only include a colour, capacity or size that you can see in the photos, that the seller notes or barcode give, or that your search confirms for this exact item. Never guess hidden specs such as storage. No hype, no ALL CAPS, no lot number.
- description: 2 to 4 short factual sentences with the product's key specifications (for example screen size, capacity, dimensions, materials, power, year of release), then any visible wear or damage. Do not repeat the seller notes; they are shown separately.
- source: ${search ? 'the website name and URL where you found the specifications, e.g. "apple.com — https://www.apple.com/..."' : "an empty string"}.
- If you cannot find the exact product, describe accurately what it appears to be, use a general title (e.g. "Vintage Brass Mechanical Device"), set confidence to "low" and leave source empty.
- Never invent brands, model numbers, ages, authenticity or values. No prices or estimates.

Seller notes (facts to rely on): ${notes || "(none)"}`;
}

function isModelGone(code, msg) {
  const m = (msg || "").toLowerCase();
  if (code === 404) return true;
  return [400, 410, 422].includes(code) && /does not exist|decommissioned|deprecated|not found|invalid model|unknown model|no endpoints|model_not_found/.test(m);
}

async function send(url, opts, errPath) {
  let r;
  try { r = await fetch(url, opts); }
  catch { throw new Error("couldn't reach the service (offline, or it blocks web apps)"); }
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) {
    let msg = (j && errPath(j)) || text.slice(0, 200);
    if (typeof msg !== "string") msg = JSON.stringify(msg);
    if (isModelGone(r.status, msg)) throw new ModelGone(`${r.status} ${msg.slice(0, 160)}`);
    const hint = { 401: " (check the API key)", 403: " (check the API key)", 402: " (out of credit)", 429: " (out of free requests for now — try later or switch AI)" }[r.status] || "";
    throw new Error(`${r.status} ${msg.slice(0, 160)}${hint}`);
  }
  return j || {};
}

async function callClaude(p, model, imgs, notes, search) {
  const content = imgs.map(d => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: d } }));
  content.push({ type: "text", text: prompt(notes, search) });
  const body = { model, max_tokens: search ? 2500 : 800, messages: [{ role: "user", content }] };
  if (search) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];
  const o = await send("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-api-key": ai.key(p.id), "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  }, j => j.error && j.error.message);
  const t = (o.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  if (search && !t.includes("{")) throw new Error("no answer after web search");
  return t;
}

async function callGemini(p, model, imgs, notes, search) {
  const parts = imgs.map(d => ({ inline_data: { mime_type: "image/jpeg", data: d } }));
  parts.push({ text: prompt(notes, search) });
  const gen = { maxOutputTokens: 4096 };
  if (!search) gen.responseMimeType = "application/json";
  const body = { contents: [{ role: "user", parts }], generationConfig: gen };
  if (search) body.tools = [{ google_search: {} }];
  const path = model.startsWith("models/") ? model : "models/" + model;
  const o = await send(`https://generativelanguage.googleapis.com/v1beta/${path}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": ai.key(p.id) },
    body: JSON.stringify(body),
  }, j => j.error && j.error.message);
  const c = (o.candidates || [])[0];
  if (!c) throw new Error("Gemini gave no answer");
  const t = ((c.content || {}).parts || []).filter(x => !x.thought).map(x => x.text || "").join("");
  if (search && !t.includes("{")) throw new Error("no answer after web search");
  return t;
}

function oaHeaders(p) {
  const h = { "content-type": "application/json" };
  const k = ai.key(p.id);
  if (k) h.Authorization = "Bearer " + k;
  if (p.id === "openrouter") h["X-Title"] = "Auction Camera";
  return h;
}

async function callOpenAI(p, model, imgs, notes) {
  const content = [{ type: "text", text: prompt(notes, false) }];
  for (const d of imgs) {
    const url = "data:image/jpeg;base64," + d;
    content.push({ type: "image_url", image_url: p.urlAsString ? url : { url } });
  }
  const body = JSON.stringify({ model, max_tokens: 2500, messages: [{ role: "user", content }] });
  const err = j => (j.error && (j.error.message || j.error)) || j.message || j.detail;
  let o;
  try {
    o = await send(ai.base(p) + "/chat/completions", { method: "POST", headers: oaHeaders(p), body }, err);
  } catch (e) {
    if (p.id === "pollinations" && !ai.key(p.id) && !(e instanceof ModelGone)) {
      o = await send("https://text.pollinations.ai/openai", { method: "POST", headers: { "content-type": "application/json" }, body }, err);
    } else throw e;
  }
  const msg = ((o.choices || [])[0] || {}).message;
  if (!msg) throw new Error(p.name + " gave no answer");
  return Array.isArray(msg.content) ? msg.content.map(x => x.text || "").join("") : (msg.content || "");
}

const VISION = ["vision", "-vl", "vl-", "pixtral", "gemma-3", "gemma-4", "scout", "maverick", "llava", "gpt-4o", "gpt-4.1", "gpt-5", "multimodal", "omni", "qwen3.", "mistral-medium", "mistral-small", "mistral-large", "kimi-k2.5"];
const NOT_CHAT = ["embed", "whisper", "tts", "audio", "guard", "moderation", "rerank", "flux", "dall", "image-gen", "imagen", "veo", "transcribe", "ocr", "realtime", "codestral", "coder", "search"];

async function discover(p) {
  if (p.kind === "gemini") {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": ai.key(p.id) } });
    const j = await r.json();
    return (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace("models/", ""))
      .filter(n => n.includes("flash") && !NOT_CHAT.some(x => n.includes(x)) && !n.includes("image") && !n.includes("live"))
      .sort((a, b) => (/preview|exp/.test(a) - /preview|exp/.test(b)) || b.localeCompare(a));
  }
  if (p.kind === "claude") {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": ai.key(p.id), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" } });
    const ids = ((await r.json()).data || []).map(m => m.id);
    const fam = ["haiku", "sonnet", "opus"].find(f => ai.model(p).includes(f)) || "haiku";
    return [...ids.filter(i => i.includes(fam)), ...ids.filter(i => i.includes("sonnet") && !i.includes(fam))];
  }
  const r = await fetch(ai.base(p) + "/models", { headers: oaHeaders(p) });
  const j = await r.json();
  const arr = j.data || j.models || (Array.isArray(j) ? j : []);
  const sure = [], maybe = [];
  for (const m of arr) {
    const id = (typeof m === "string" ? m : m.id || m.name || "").trim();
    const lid = id.toLowerCase();
    if (!id || NOT_CHAT.some(x => lid.includes(x)) || m.active === false) continue;
    const mods = JSON.stringify(m.input_modalities || (m.architecture && (m.architecture.input_modalities || m.architecture.modality)) || "");
    if (mods.includes("image") || (m.capabilities && m.capabilities.vision)) sure.push(id);
    else if (VISION.some(v => lid.includes(v))) maybe.push(id);
  }
  const all = [...sure, ...maybe];
  return p.id === "openrouter" ? all.sort((a, b) => (b.endsWith(":free") - a.endsWith(":free"))) : all;
}

function parse(raw, p, model) {
  const t = raw.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
  const end = t.lastIndexOf("}");
  let j = null;
  for (let s = t.indexOf("{"); s >= 0 && s < end; s = t.indexOf("{", s + 1)) {
    try { const c = JSON.parse(t.slice(s, end + 1)); if (c.title) { j = c; break; } } catch { /* try narrower */ }
  }
  if (!j) throw new Error("couldn't read the answer");
  let title = String(j.title).trim();
  if (title.length > 50) {
    const cut = title.slice(0, 50), sp = cut.lastIndexOf(" ");
    title = (sp > 30 ? cut.slice(0, sp) : cut).replace(/[,\s-]+$/, "");
  }
  return { title, description: String(j.description || "").trim(), confidence: j.confidence || "medium", source: String(j.source || "").trim(), provider: p.name, model };
}

async function callOnce(p, model, imgs, notes, search) {
  if (p.kind === "claude") return callClaude(p, model, imgs, notes, search);
  if (p.kind === "gemini") return callGemini(p, model, imgs, notes, search);
  return callOpenAI(p, model, imgs, notes);
}

async function call(p, model, imgs, notes) {
  const canSearch = prefs.get("webSpecs", true) && (p.kind === "gemini" || p.kind === "claude");
  if (canSearch) {
    try { return parse(await callOnce(p, model, imgs, notes, true), p, model); }
    catch (e) { if (e instanceof ModelGone) throw e; console.warn("search failed, retrying without search", e); }
  }
  return parse(await callOnce(p, model, imgs, notes, false), p, model);
}

/** Identify with one AI; replaces a retired model automatically. */
export async function identifyWith(p, imgs, notes) {
  let model = ai.model(p);
  if ((RETIRED[p.id] || []).includes(model)) { model = p.model; prefs.set("model_" + p.id, model); }
  if (!model) throw new Error("enter a model name in Settings");
  const use = imgs.slice(0, p.max);
  try {
    return await call(p, model, use, notes);
  } catch (e) {
    if (!(e instanceof ModelGone)) throw e;
    let cands = [];
    try { cands = (await discover(p)).filter(m => m !== model).slice(0, 4); } catch { /* list unavailable */ }
    for (const m of cands) {
      try { const r = await call(p, m, use, notes); prefs.set("model_" + p.id, m); return r; }
      catch (e2) { if (e2 instanceof ModelGone || /image/i.test(e2.message)) continue; throw e2; }
    }
    throw new Error(e.message + " — no working replacement model found");
  }
}

/** Identify with the chosen AI, falling back to the others that are set up. */
export async function identify(blobs, notes) {
  const imgs = [];
  for (const b of blobs) imgs.push(await blobToBase64(await resize(b, 1024, 0.8)));
  const chosen = ai.chosen();
  const order = [];
  if (ai.available(chosen)) order.push(chosen);
  if (prefs.get("fallback", true) || !order.length) order.push(...PROVIDERS.filter(p => p !== chosen && ai.available(p)));
  if (!order.length) throw new Error("Add an AI key in Settings first (Gemini is free)");
  const errors = [];
  for (const p of order) {
    try { return await identifyWith(p, imgs, notes); }
    catch (e) { errors.push(`${p.name}: ${e.message}`); }
  }
  throw new Error(errors.join("\n"));
}

/** Tiny red-square test so you can check a key before an auction. */
export async function testProvider(p) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#d22"; g.fillRect(0, 0, 128, 128);
  const b = await new Promise(r => c.toBlob(r, "image/jpeg", 0.9));
  return identifyWith(p, [await blobToBase64(b)], "This is a test picture of a plain red square.");
}
