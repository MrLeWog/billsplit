'use strict';
/* Bill Split. Bill data lives only in the share link (URL fragment, never sent to a server)
   and in this device's localStorage. */

// ====================== pure logic ======================
function toCents(v) {
  const n = parseFloat(String(v).replace(/[^0-9.,\-]/g, '').replace(',', '.'));
  return isFinite(n) ? Math.round(n * 100) : 0;
}
function money(c, cur) { return (c < 0 ? '-' : '') + (cur || '$') + (Math.abs(c) / 100).toFixed(2); }
const sumItems = b => b.items.reduce((a, x) => a + x.p, 0);

function parseReceipt(text) {
  const items = []; let extra = 0, xl = '', total = null;
  const SKIP = /\b(sub\s*-?\s*total|change|cash|eftpos|visa|mastercard|amex|tendered|balance|rounding|discount|gst|tax|abn|tel|phone|receipt|invoice|thank|saving|points|paid)\b/i;
  const EXTRA = /\b(surcharge|service\s*charge|tip|gratuity)\b/i;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[|_~]/g, ' ').replace(/\s+/g, ' ').trim();
    if (line.length < 3) continue;
    const m = line.match(/^(.*?)\s*\$?\s*(-?\d{1,5}[.,]\d{2})\s*[A-Za-z]{0,2}$/);
    if (!m) continue;
    let name = m[1].replace(/[\s.$:*]+$/, '').trim();
    const p = Math.round(parseFloat(m[2].replace(',', '.')) * 100);
    if (!(p > 0)) continue;
    if (/\btotal\b/i.test(name) && !/sub|gst|tax|saving|item/i.test(name)) { total = p; continue; }
    if (SKIP.test(name)) continue;
    if (EXTRA.test(name)) { extra += p; xl = xl || name.replace(/[^A-Za-z ]/g, '').trim(); continue; }
    let q = 1; const qm = name.match(/^(\d{1,2})\s*[xX]?\s+(.+)$/);
    if (qm && +qm[1] >= 1 && +qm[1] <= 20) { q = +qm[1]; name = qm[2]; }
    name = name.replace(/^[^A-Za-z0-9(]+/, '').trim();
    if (name.length < 2) continue;
    if (q === 1) items.push({ n: name, p });
    else { const u = Math.floor(p / q); for (let k = 0; k < q; k++) items.push({ n: name, p: u + (k === 0 ? p - u * q : 0) }); }
  }
  return { items, extra, xl, total };
}

// picks: { personIndex: [[itemIndex, splitBetweenN], ...] }
function computeTotals(bill, picks) {
  const n = bill.people.length, sub = new Array(n).fill(0), cov = bill.items.map(() => 0);
  const pre = bill.pre || {};
  bill.items.forEach((it, i) => {
    const pr = pre[i] || [];
    if (pr.length) { pr.forEach(pi => { if (pi < n) sub[pi] += it.p / pr.length; }); cov[i] = 1; }
  });
  for (const k in (picks || {})) {
    const pi = +k; if (!(pi >= 0 && pi < n)) continue;
    for (const [i, d] of picks[k]) {
      const it = bill.items[i]; if (!it || (pre[i] && pre[i].length)) continue;
      const dv = Math.max(1, d | 0);
      sub[pi] += it.p / dv; cov[i] += 1 / dv;
    }
  }
  const billSub = sumItems(bill) || 1, extra = bill.extra || 0;
  return { sub: sub.map(Math.round), totals: sub.map(s => Math.round(s + extra * s / billSub)), cov };
}

const compact = b => ({ v: 1, i: b.id, t: b.title, c: b.c, x: b.extra, l: b.xl, n: b.pn, it: b.items.map(x => [x.n, x.p]), pp: b.people, pr: b.pre });
const expand = o => ({ id: o.i, title: o.t || '', c: o.c || '$', extra: o.x || 0, xl: o.l || '', pn: o.n || '',
  items: o.it.map(([n, p]) => ({ n, p })), people: o.pp, pre: o.pr || {} });

function bytesToB64u(bytes) {
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
}
async function pack(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream !== 'undefined') {
    const buf = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    return 'z' + bytesToB64u(buf);
  }
  return 'j' + bytesToB64u(json);
}
async function unpack(s) {
  let bytes = b64uToBytes(s.slice(1));
  if (s[0] === 'z') bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  return JSON.parse(new TextDecoder().decode(bytes));
}

if (typeof document === 'undefined') {
  module.exports = { toCents, money, parseReceipt, computeTotals, compact, expand, pack, unpack };
} else {
// ====================== UI ======================
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = () => Math.random().toString(36).slice(2, 8);
const load = () => { try { return JSON.parse(localStorage.getItem('bsr.bills') || '[]'); } catch (e) { return []; } };
const persist = () => { try { localStorage.setItem('bsr.bills', JSON.stringify(S.bills)); } catch (e) {} };
const S = { bills: load(), bill: null, step: 'home', link: null, guest: null, busy: '', err: '' };
const newBill = () => ({ id: rid(), created: Date.now(), title: '', c: '$', items: [], extra: 0, xl: '', pn: '', people: [], pre: {}, replies: {}, raw: '', total: null });

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied'); } catch (e2) { toast('Select and copy manually'); }
    ta.remove();
  }
}
async function share(title, text) {
  if (navigator.share) { try { await navigator.share({ title, text }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  copy(text);
}
const stepbar = n => `<div class="steps">${['Photo', 'Items', 'People', 'Shared'].map((s, i) => `<span class="${i + 1 === n ? 'on' : i + 1 < n ? 'done' : ''}">${i + 1}. ${s}</span>`).join('')}</div>`;

// ---------- host views ----------
function vHome() {
  return `<header><h1>Split the bill</h1><p class="sub">Bills stay on this phone. Nothing is uploaded.</p></header>
  <button class="btn primary big" data-act="new">+ New bill</button>
  ${S.bills.map((b, i) => `<button class="card billcard" data-act="open" data-i="${i}"><b>${esc(b.title || 'Untitled bill')}</b>
    <span>${new Date(b.created).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} · ${b.people.length ? b.people.length + ' people' : 'draft'} · ${money(sumItems(b) + b.extra, b.c)}</span></button>`).join('')}`;
}
function vScan() {
  return `${stepbar(1)}<h2>Photo of the bill</h2>
  ${S.busy ? `<div class="card"><div id="prog-t">${esc(S.busy)}</div><div class="progress"><i id="prog-b"></i></div></div>` : `
  <label class="btn primary big">Take or choose photo<input type="file" accept="image/*" id="file" hidden></label>
  <button class="btn big" data-act="manual">Enter items manually</button>`}
  ${S.err ? `<p class="warn">${esc(S.err)}</p>` : ''}
  <p class="hint">The photo is read on your phone and never uploaded. The first scan needs internet to fetch the reader (about 15 MB); after that it's cached.</p>
  <div class="nav"><button class="btn" data-act="home">Cancel</button></div>`;
}
function vReview() {
  const b = S.bill;
  return `${stepbar(2)}<h2>Check the items</h2>
  <input data-bind="title" placeholder="Bill name (e.g. Friday dinner)" value="${esc(b.title)}">
  <div class="row"><label class="lbl">Currency symbol</label><input data-bind="cur" class="price" style="width:70px" value="${esc(b.c)}"></div>
  ${b.items.map((it, i) => `<div class="row"><input data-bind="iname" data-i="${i}" placeholder="Item" value="${esc(it.n)}"><input data-bind="iprice" data-i="${i}" class="price" inputmode="decimal" value="${(it.p / 100).toFixed(2)}"><button class="x" data-act="del" data-i="${i}" aria-label="Remove">✕</button></div>`).join('')}
  <button class="btn" data-act="additem">+ Add item</button>
  <div class="card"><div class="lbl">Surcharge / tip / service (optional)</div>
    <div class="row"><input data-bind="xl" placeholder="Label" value="${esc(b.xl)}"><input data-bind="extra" class="price" inputmode="decimal" value="${(b.extra / 100).toFixed(2)}"></div>
    <p class="hint">Shared out in proportion to what each person had.</p></div>
  <input data-bind="pn" placeholder="How friends should pay you (PayID, BSB…) optional" value="${esc(b.pn)}">
  <div id="sum" class="sum">${sumHtml()}</div>
  ${b.raw ? `<details><summary>Show text read from photo</summary><pre>${esc(b.raw)}</pre></details>` : ''}
  <div class="nav"><button class="btn" data-act="to" data-s="scan">Back</button><button class="btn primary" data-act="to" data-s="people">Next: People</button></div>`;
}
function sumHtml() {
  const b = S.bill, s = sumItems(b), tot = s + b.extra;
  let h = `Items ${money(s, b.c)}${b.extra ? ` + extras ${money(b.extra, b.c)}` : ''} = <b>${money(tot, b.c)}</b>`;
  if (b.total != null) {
    const d = tot - b.total;
    h += Math.abs(d) < 2 ? `<br><span class="ok">Matches receipt total ✓</span>` : `<br><span class="warn">Receipt total ${money(b.total, b.c)} (difference ${money(d, b.c)}). Check for a missed or misread item.</span>`;
  }
  return h;
}
function vPeople() {
  const b = S.bill;
  return `${stepbar(3)}<h2>Who's splitting?</h2>
  <div class="row"><input id="pname" placeholder="Add a name" autocomplete="off"><button class="btn primary" data-act="addperson">Add</button></div>
  <p class="hint">Include yourself. Separate several names with commas.</p>
  <div class="chips">${b.people.map((p, i) => `<span class="chip on">${esc(p)} <button class="chipx" data-act="delperson" data-i="${i}" aria-label="Remove ${esc(p)}">✕</button></span>`).join('')}</div>
  <div class="nav"><button class="btn" data-act="to" data-s="review">Back</button><button class="btn primary" data-act="to" data-s="assign">Next: Shared items</button></div>`;
}
function vAssign() {
  const b = S.bill;
  return `${stepbar(4)}<h2>Shared items</h2>
  <p class="hint">Optional. For things everyone knows are shared (a platter, a bottle), tap the people who had it. It's split evenly and locked in. Leave the rest for friends to tick themselves.</p>
  ${b.items.map((it, i) => { const pr = b.pre[i] || []; return `<div class="card"><div class="line"><span>${esc(it.n)}</span><b>${money(it.p, b.c)}</b></div>
    <div class="chips">${b.people.map((p, pi) => `<button class="chip ${pr.includes(pi) ? 'on' : ''}" data-act="pre" data-i="${i}" data-pi="${pi}">${esc(p)}</button>`).join('')}
    <button class="chip" data-act="preall" data-i="${i}">${pr.length === b.people.length ? 'Clear' : 'Everyone'}</button></div></div>`; }).join('')}
  <div class="nav"><button class="btn" data-act="to" data-s="people">Back</button><button class="btn primary" data-act="to" data-s="dash">Create link</button></div>`;
}
function vDash() {
  const b = S.bill, r = computeTotals(b, b.replies), replied = Object.keys(b.replies).length;
  const flagged = b.items.map((it, i) => ({ it, i, c: r.cov[i] })).filter(x => Math.abs(x.c - 1) > 0.005);
  const unclaimed = b.items.reduce((a, it, i) => a + Math.round(it.p * Math.max(0, 1 - r.cov[i])), 0);
  return `<header><button class="link" data-act="home">‹ All bills</button><h1>${esc(b.title || 'Untitled bill')}</h1>
  <p class="sub">${money(sumItems(b) + b.extra, b.c)} · ${b.people.length} people · <button class="link" data-act="to" data-s="review">items</button> · <button class="link" data-act="to" data-s="people">people</button> · <button class="link" data-act="to" data-s="assign">shared</button></p></header>
  <div class="card"><h3>1. Send this link to everyone</h3>
    ${S.link ? `<textarea readonly rows="3" id="linkbox">${esc(S.link)}</textarea>
    <div class="row"><button class="btn primary" data-act="sharelink">Share</button><button class="btn" data-act="copylink">Copy link</button></div>
    <p class="hint">The bill is inside the link. There's no server and nothing is stored online. Friends pick their name and tick what they had.</p>` : '<p class="hint">Making link…</p>'}
    <button class="btn" data-act="fillmine">Tick my own items</button></div>
  <div class="card"><h3>2. Collect replies</h3>
    <p class="hint">Each friend taps “Send to host” and messages you a reply. Paste it here.</p>
    <textarea id="paste" rows="2" placeholder="Paste reply (contains BSR:…)"></textarea>
    <button class="btn" data-act="addreply">Add reply</button></div>
  <div class="card"><h3>Who owes what</h3>
    ${b.people.map((p, i) => { const ok = b.replies[i] != null; return `<div class="line"><span>${esc(p)} <small class="${ok ? 'ok' : 'mute'}">${ok ? '✓ replied' : 'waiting'}</small></span><b class="${ok ? '' : 'mute'}">${money(r.totals[i], b.c)}</b></div>`; }).join('')}
    ${replied ? (flagged.length ? `<div class="warn" style="margin-top:8px"><b>Check these${unclaimed ? ` (${money(unclaimed, b.c)} unclaimed)` : ''}:</b>${flagged.map(x => `<div class="line"><span>${esc(x.it.n)}</span><span>${x.c < 0.005 ? 'nobody' : x.c < 1 ? 'partly claimed' : 'claimed twice'}</span></div>`).join('')}</div>` : '<p class="ok">Every item is claimed exactly once ✓</p>') : '<p class="hint">Greyed totals are only the shared items so far.</p>'}
    <button class="btn" data-act="summary">Copy summary for the group chat</button></div>
  <button class="link danger" data-act="delbill">Delete this bill</button>`;
}

// ---------- guest view (also used by host for "tick my own items") ----------
function startGuest(bill, local) {
  const saved = local ? null : (() => { try { return JSON.parse(localStorage.getItem('bsr.g.' + bill.id)); } catch (e) { return null; } })();
  S.guest = { bill, local: !!local, me: saved ? saved.me : null, picks: saved ? saved.picks : [], sent: '' };
}
function gSave() { const G = S.guest; if (!G.local) try { localStorage.setItem('bsr.g.' + G.bill.id, JSON.stringify({ me: G.me, picks: G.picks })); } catch (e) {} }
function vGuest() {
  const G = S.guest, b = G.bill;
  if (G.err) return `<header><h1>Oops</h1><p class="warn">${esc(G.err)}</p></header>`;
  const back = G.local ? `<button class="link" data-act="gback">‹ Back</button>` : '';
  if (G.me == null) return `${back}<header><h1>${esc(b.title || 'Split the bill')}</h1><p class="sub">Total ${money(sumItems(b) + b.extra, b.c)}</p></header>
    <h2>Who are you?</h2><div class="chips">${b.people.map((p, i) => `<button class="chip big" data-act="me" data-i="${i}">${esc(p)}</button>`).join('')}</div>`;
  const t = computeTotals(b, { [G.me]: G.picks }), tot = t.totals[G.me];
  const pickable = [], shared = [];
  b.items.forEach((it, i) => ((b.pre[i] || []).length ? shared : pickable).push(i));
  return `${back}<header><h1>${esc(b.title || 'Split the bill')}</h1><p class="sub">Hi ${esc(b.people[G.me])}. Tick what you had. <button class="link" data-act="changeme">Not you?</button></p></header>
  ${shared.length ? `<h3>Already shared with you</h3>${shared.filter(i => b.pre[i].includes(G.me)).map(i => `<div class="card line"><span>${esc(b.items[i].n)} <small class="mute">split ${b.pre[i].length} ways</small></span><b>${money(Math.round(b.items[i].p / b.pre[i].length), b.c)}</b></div>`).join('') || '<p class="hint">None of the shared items include you.</p>'}` : ''}
  <h3>What did you have?</h3>
  ${pickable.map(i => { const it = b.items[i], pk = G.picks.find(x => x[0] === i), on = !!pk;
    return `<div class="pick ${on ? 'on' : ''}"><button class="pickbtn" data-act="tick" data-i="${i}"><span class="box">${on ? '✓' : ''}</span><span class="n">${esc(it.n)}</span><b>${money(it.p, b.c)}</b></button>
    ${on ? `<div class="split">Split between <button class="step" data-act="dm" data-i="${i}">−</button><b>${pk[1]}</b><button class="step" data-act="dp" data-i="${i}">+</button> ${pk[1] === 1 ? 'person (just me)' : 'people'} <em>→ ${money(Math.round(it.p / pk[1]), b.c)}</em></div>` : ''}</div>`; }).join('')}
  ${G.sent ? `<div class="card"><h3>Reply ready</h3><p class="hint">Send this message to whoever's collecting the money.</p><textarea readonly rows="3" id="replybox">${esc(G.sent)}</textarea>
    <div class="row"><button class="btn primary" data-act="sharereply">Share</button><button class="btn" data-act="copyreply">Copy</button></div></div>` : ''}
  ${b.extra ? `<p class="hint">Includes your share of ${esc(b.xl || 'extras')} (${money(b.extra, b.c)} total).</p>` : ''}
  ${b.pn && !G.local ? `<div class="card"><small class="mute">Pay</small><div>${esc(b.pn)}</div></div>` : ''}
  <div class="bar"><div><small class="mute">You owe</small><div class="amt">${money(tot, b.c)}</div></div>
    <button class="btn primary" data-act="${G.local ? 'savelocal' : 'send'}">${G.local ? 'Save my picks' : 'Send to host'}</button></div>`;
}

// ---------- render + events ----------
function render() { $('#app').innerHTML = S.guest ? vGuest() : ({ home: vHome, scan: vScan, review: vReview, people: vPeople, assign: vAssign, dash: vDash }[S.step])(); window.scrollTo(0, 0); }
async function genLink() {
  S.link = null; const base = location.href.split('#')[0];
  S.link = base + '#b=' + await pack(compact(S.bill)); if (S.step === 'dash' && !S.guest) render();
}
function go(step) { S.step = step; S.err = ''; render(); }
function cleanItems() { S.bill.items = S.bill.items.filter(x => x.n.trim() || x.p > 0); S.bill.items.forEach(x => { if (!x.n.trim()) x.n = 'Item'; }); }
function removePerson(p) {
  const b = S.bill; b.people.splice(p, 1);
  const fix = a => a.filter(x => x !== p).map(x => x > p ? x - 1 : x);
  for (const k of Object.keys(b.pre)) { b.pre[k] = fix(b.pre[k]); if (!b.pre[k].length) delete b.pre[k]; }
  const nr = {}; for (const k of Object.keys(b.replies)) { const i = +k; if (i !== p) nr[i > p ? i - 1 : i] = b.replies[k]; } b.replies = nr;
}
function summaryText() {
  const b = S.bill, r = computeTotals(b, b.replies);
  return `${b.title || 'Bill'} (${money(sumItems(b) + b.extra, b.c)})\n` + b.people.map((p, i) => `${p}: ${money(r.totals[i], b.c)}${b.replies[i] == null ? ' (not replied yet, shared items only)' : ''}`).join('\n') + (b.pn ? `\nPay: ${b.pn}` : '');
}

async function prepImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); }); }
  const w0 = bmp.width, h0 = bmp.height, sc = Math.min(1, 2200 / Math.max(w0, h0));
  const c = document.createElement('canvas'); c.width = Math.round(w0 * sc); c.height = Math.round(h0 * sc);
  const x = c.getContext('2d'); x.drawImage(bmp, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height), px = d.data;
  for (let i = 0; i < px.length; i += 4) { let g = 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2]; g = (g - 128) * 1.5 + 128; px[i] = px[i + 1] = px[i + 2] = g < 0 ? 0 : g > 255 ? 255 : g; }
  x.putImageData(d, 0, 0); return c;
}
function loadScript(src) { return new Promise((res, rej) => { if (window.Tesseract) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('offline')); document.head.appendChild(s); }); }
function prog(t, p) { const a = $('#prog-t'), b = $('#prog-b'); if (a) a.textContent = t; if (b && p != null) b.style.width = Math.round(p * 100) + '%'; }
async function scan(file) {
  if (!file) return;
  S.busy = 'Preparing image…'; S.err = ''; render();
  try {
    const canvas = await prepImage(file);
    prog('Loading reader…', 0.05);
    await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
    const worker = await Tesseract.createWorker('eng', 1, { logger: m => { if (m.status) prog(m.status.replace(/^./, c => c.toUpperCase()) + '…', m.progress); } });
    const { data } = await worker.recognize(canvas); await worker.terminate();
    const r = parseReceipt(data.text), b = S.bill;
    b.items = r.items; b.extra = r.extra; b.xl = r.xl; b.total = r.total; b.raw = data.text;
    if (!b.items.length) b.items = [{ n: '', p: 0 }];
    S.busy = ''; if (!S.bills.includes(b)) S.bills.unshift(b); persist(); go('review');
  } catch (e) {
    S.busy = ''; S.err = e && e.message === 'offline' ? 'Could not download the reader. Connect to the internet and try again, or enter items manually.' : 'Could not read that photo. Try a flatter, brighter shot, or enter items manually.'; render();
  }
}

document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'file') return scan(t.files[0]);
  const k = t.dataset.bind; if (!k || !S.bill) return; const b = S.bill, i = +t.dataset.i;
  if (k === 'title') b.title = t.value; else if (k === 'cur') b.c = t.value.trim() || '$';
  else if (k === 'iname') b.items[i].n = t.value; else if (k === 'iprice') { b.items[i].p = Math.max(0, toCents(t.value)); t.value = (b.items[i].p / 100).toFixed(2); }
  else if (k === 'extra') { b.extra = Math.max(0, toCents(t.value)); t.value = (b.extra / 100).toFixed(2); }
  else if (k === 'xl') b.xl = t.value; else if (k === 'pn') b.pn = t.value;
  persist(); const s = $('#sum'); if (s) s.innerHTML = sumHtml();
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'pname') { e.preventDefault(); act('addperson', e.target); } });
document.addEventListener('click', e => { const el = e.target.closest('[data-act]'); if (el) act(el.dataset.act, el); });

async function act(a, el) {
  const b = S.bill, G = S.guest, i = +el.dataset.i;
  switch (a) {
    case 'new': S.bill = newBill(); go('scan'); break;
    case 'home': S.bill = null; S.guest = null; go('home'); break;
    case 'open': S.bill = S.bills[i]; if (S.bill.people.length >= 2 && S.bill.items.length) { go('dash'); genLink(); } else go('review'); break;
    case 'manual': b.items = [{ n: '', p: 0 }]; if (!S.bills.includes(b)) S.bills.unshift(b); persist(); go('review'); break;
    case 'additem': b.items.push({ n: '', p: 0 }); persist(); render(); { const r = document.querySelectorAll('input[data-bind=iname]'); r[r.length - 1].focus(); } break;
    case 'del': b.items.splice(i, 1); b.pre = {}; persist(); render(); break;
    case 'to': {
      const s = el.dataset.s;
      if (['people', 'assign', 'dash'].includes(s) && S.step === 'review') { cleanItems(); if (!b.items.length) return toast('Add at least one item'); }
      if (['assign', 'dash'].includes(s) && S.step !== 'dash' && b.people.length < 2) return toast('Add at least two people');
      persist(); go(s); if (s === 'dash') genLink(); break;
    }
    case 'addperson': {
      const inp = $('#pname'); const names = inp.value.split(',').map(x => x.trim()).filter(Boolean);
      names.forEach(n => { if (b.people.length < 30) b.people.push(n); }); persist(); render(); $('#pname').focus(); break;
    }
    case 'delperson': removePerson(i); persist(); render(); break;
    case 'pre': { const pi = +el.dataset.pi, a2 = b.pre[i] || []; const n = a2.includes(pi) ? a2.filter(x => x !== pi) : [...a2, pi].sort((x, y) => x - y); if (n.length) b.pre[i] = n; else delete b.pre[i]; persist(); render(); break; }
    case 'preall': if ((b.pre[i] || []).length === b.people.length) delete b.pre[i]; else b.pre[i] = b.people.map((_, k) => k); persist(); render(); break;
    case 'copylink': copy(S.link); break;
    case 'sharelink': share(b.title || 'Split the bill', `Split "${b.title || 'the bill'}": open this, pick your name and tick what you had.\n${S.link}`); break;
    case 'fillmine': startGuest(b, true); render(); break;
    case 'addreply': {
      const m = ($('#paste').value || '').match(/BSR:([A-Za-z0-9_-]+)/); if (!m) return toast('No reply code found');
      try { const o = await unpack(m[1]); if (o.i !== b.id) return toast('That reply is for a different bill'); if (!b.people[o.p]) return toast('Unknown person in reply');
        b.replies[o.p] = o.s; persist(); render(); toast(`${b.people[o.p]}'s picks added`); } catch (e) { toast('Could not read that reply'); }
      break;
    }
    case 'summary': copy(summaryText()); break;
    case 'delbill': if (confirm('Delete this bill from your phone?')) { S.bills.splice(S.bills.indexOf(b), 1); persist(); S.bill = null; go('home'); } break;
    // guest
    case 'me': G.me = i; G.picks = G.local ? (G.bill.replies[i] || []).map(x => x.slice()) : G.picks; gSave(); render(); break;
    case 'changeme': G.me = null; G.picks = []; G.sent = ''; gSave(); render(); break;
    case 'tick': { const k = G.picks.findIndex(x => x[0] === i); if (k >= 0) G.picks.splice(k, 1); else G.picks.push([i, 1]); G.sent = ''; gSave(); render(); break; }
    case 'dm': { const p = G.picks.find(x => x[0] === i); p[1] = Math.max(1, p[1] - 1); G.sent = ''; gSave(); render(); break; }
    case 'dp': { const p = G.picks.find(x => x[0] === i); p[1] = Math.min(G.bill.people.length, p[1] + 1); G.sent = ''; gSave(); render(); break; }
    case 'send': {
      const code = await pack({ i: G.bill.id, p: G.me, s: G.picks });
      G.sent = `Bill reply: ${G.bill.title || 'Bill'}, ${G.bill.people[G.me]}\nBSR:${code}`; render();
      share('Bill reply', G.sent); break;
    }
    case 'sharereply': share('Bill reply', G.sent); break;
    case 'copyreply': copy(G.sent); break;
    case 'savelocal': G.bill.replies[G.me] = G.picks; persist(); S.guest = null; go('dash'); toast('Saved'); break;
    case 'gback': S.guest = null; go('dash'); break;
  }
}

async function boot() {
  const h = location.hash;
  if (h.startsWith('#b=')) {
    try { startGuest(expand(await unpack(h.slice(3))), false); }
    catch (e) { S.guest = { err: 'This link looks incomplete or broken. Ask the host to send it again.', bill: { title: '' } }; }
  }
  render();
}
addEventListener('hashchange', () => location.reload());
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
}
