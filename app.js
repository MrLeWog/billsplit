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

const keyOf = (it, i) => (it.k != null ? String(it.k) : String(i));
// picks: { personIndex: [[itemKey, splitBetweenN], ...] }
function computeTotals(bill, picks) {
  const n = bill.people.length, sub = new Array(n).fill(0), cov = bill.items.map(() => 0);
  const pre = bill.pre || {}, idx = {};
  bill.items.forEach((it, i) => { idx[keyOf(it, i)] = i; });
  bill.items.forEach((it, i) => {
    const pr = pre[keyOf(it, i)] || [];
    if (pr.length) { pr.forEach(pi => { if (pi < n) sub[pi] += it.p / pr.length; }); cov[i] = 1; }
  });
  for (const k in (picks || {})) {
    const pi = +k; if (!(pi >= 0 && pi < n)) continue;
    for (const [key, d] of picks[k]) {
      const i = idx[String(key)]; if (i == null) continue;
      const it = bill.items[i], pr = pre[keyOf(it, i)]; if (pr && pr.length) continue;
      const dv = Math.max(1, d | 0);
      sub[pi] += it.p / dv; cov[i] += 1 / dv;
    }
  }
  const billSub = sumItems(bill) || 1, extra = bill.extra || 0;
  return { sub: sub.map(Math.round), totals: sub.map(s => Math.round(s + extra * s / billSub)), cov };
}

const compact = b => ({ v: 1, i: b.id, t: b.title, c: b.c, x: b.extra, l: b.xl, n: b.pn, it: b.items.map((x, i) => [x.n, x.p, keyOf(x, i)]), pp: b.people, pr: b.pre });
const expand = o => ({ id: o.i, title: o.t || '', c: o.c || '$', extra: o.x || 0, xl: o.l || '', pn: o.n || '',
  items: o.it.map(([n, p, k], i) => ({ n, p, k: k != null ? String(k) : String(i) })), people: o.pp, pre: o.pr || {} });

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
function migrate(b) {
  b.items.forEach((x, i) => { if (x.k == null) x.k = String(i); });
  b.pre = b.pre || {}; b.replies = b.replies || {}; b.paid = b.paid || {}; b.sentSig = b.sentSig || '';
  return b;
}
const load = () => { let a; try { a = JSON.parse(localStorage.getItem('bsr.bills') || '[]'); } catch (e) { a = []; } return a.map(migrate); };
const persist = () => { try { localStorage.setItem('bsr.bills', JSON.stringify(S.bills)); } catch (e) {} };
const S = { bills: load(), bill: null, step: 'home', link: null, guest: null, busy: '', err: '', fix: {} };
const newBill = () => ({ id: rid(), created: Date.now(), title: '', c: '$', items: [], extra: 0, xl: '', pn: '', people: [], pre: {}, replies: {}, paid: {}, sentSig: '', raw: '', total: null });

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
    <span>${new Date(b.created).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} · ${b.people.length ? b.people.length + ' people' : 'draft'} · ${money(sumItems(b) + b.extra, b.c)}</span></button>`).join('')}
  <div class="row" style="margin-top:20px">${S.bills.length ? '<button class="btn" data-act="export">Back up bills</button>' : ''}<label class="btn">Restore backup<input type="file" accept=".json,application/json" id="restore" hidden></label></div>
  <p class="hint">Bills only live in this browser. A backup file protects you if you ever clear browser data.</p>`;
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
    <div class="chips sm"><button class="chip" data-act="tip" data-pct="0">None</button><button class="chip" data-act="tip" data-pct="5">Tip 5%</button><button class="chip" data-act="tip" data-pct="10">Tip 10%</button><button class="chip" data-act="tip" data-pct="15">Tip 15%</button></div>
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
  ${b.items.map(it => { const pr = b.pre[it.k] || []; return `<div class="card"><div class="line"><span>${esc(it.n)}</span><b>${money(it.p, b.c)}</b></div>
    <div class="chips">${b.people.map((p, pi) => `<button class="chip ${pr.includes(pi) ? 'on' : ''}" data-act="pre" data-k="${it.k}" data-pi="${pi}">${esc(p)}</button>`).join('')}
    <button class="chip" data-act="preall" data-k="${it.k}">${pr.length === b.people.length ? 'Clear' : 'Everyone'}</button></div></div>`; }).join('')}
  <div class="nav"><button class="btn" data-act="to" data-s="people">Back</button><button class="btn primary" data-act="to" data-s="dash">Create link</button></div>`;
}
function claimants(b, k) { return Object.keys(b.replies).map(Number).filter(pi => (b.replies[pi] || []).some(x => String(x[0]) === k)); }
const sigOf = b => JSON.stringify(compact(b));
function fixRow(b, x) {
  const k = x.it.k, cl = claimants(b, k), pr = b.pre[k] || [], c = x.c;
  const st = Math.abs(c - 1) <= 0.005 ? '✓ sorted' : c < 0.005 ? 'nobody' : c < 1 ? 'partly claimed' : 'claimed twice';
  return `<div class="fix"><div class="line"><span>${esc(x.it.n)} <small>${money(x.it.p, b.c)}</small></span><span>${st}</span></div>
    <div class="chips sm">${c > 1.005 && cl.length > 1 ? `<button class="chip" data-act="fixsplit" data-k="${k}">Split between ${cl.length} claimants</button>` : ''}
    <button class="chip" data-act="preall" data-k="${k}">${pr.length === b.people.length ? 'Clear' : 'Everyone'}</button>
    ${b.people.map((p, pi) => `<button class="chip ${pr.includes(pi) ? 'on' : ''}" data-act="pre" data-k="${k}" data-pi="${pi}">${esc(p)}</button>`).join('')}</div></div>`;
}
function vDash() {
  const b = S.bill, r = computeTotals(b, b.replies), replied = Object.keys(b.replies).length;
  const list = b.items.map((it, i) => ({ it, c: r.cov[i] })).filter(x => Math.abs(x.c - 1) > 0.005 || S.fix[x.it.k]);
  const unclaimed = b.items.reduce((a, it, i) => a + Math.round(it.p * Math.max(0, 1 - r.cov[i])), 0);
  const billTot = sumItems(b) + b.extra, sumT = r.totals.reduce((a, x) => a + x, 0);
  const paidTot = b.people.reduce((a, p, i) => a + (b.paid[i] ? r.totals[i] : 0), 0);
  const stale = b.sentSig && b.sentSig !== sigOf(b);
  const allIn = replied === b.people.length && !list.length;
  return `<header><button class="link" data-act="home">‹ All bills</button><h1>${esc(b.title || 'Untitled bill')}</h1>
  <p class="sub">${money(billTot, b.c)} · ${b.people.length} people · <button class="link" data-act="to" data-s="review">items</button> · <button class="link" data-act="to" data-s="people">people</button> · <button class="link" data-act="to" data-s="assign">shared</button></p></header>
  ${stale ? `<div class="card"><b class="warn">You changed the bill after sending the link.</b><p class="hint">Friends who already opened it still see the old version. Send the new link below. Replies already sent still work.</p></div>` : ''}
  <div class="card"><h3>1. Send this link to everyone</h3>
    ${S.link ? `<textarea readonly rows="3" id="linkbox">${esc(S.link)}</textarea>
    <div class="row"><button class="btn primary" data-act="sharelink">Share</button><button class="btn" data-act="copylink">Copy link</button></div>
    <p class="hint">The bill is inside the link. There's no server and nothing is stored online. Friends pick their name and tick what they had.</p>` : '<p class="hint">Making link…</p>'}
    <button class="btn" data-act="fillmine">Tick my own items</button></div>
  <div class="card"><h3>2. Collect replies</h3>
    <p class="hint">Each friend taps “Send to host” and messages you a reply. Paste one, or paste the whole group chat and I'll find them all.</p>
    <textarea id="paste" rows="2" placeholder="Paste replies (they contain BSR:…)"></textarea>
    <button class="btn" data-act="addreply">Add replies</button></div>
  <div class="card"><h3>Who owes what</h3>
    ${b.people.map((p, i) => { const ok = b.replies[i] != null, paid = !!b.paid[i]; return `<div class="line"><span>${esc(p)} <small class="${ok ? 'ok' : 'mute'}">${ok ? '✓ replied' : 'waiting'}</small></span><span class="r"><b class="${ok ? '' : 'mute'}">${money(r.totals[i], b.c)}</b> <button class="chip sm ${paid ? 'on' : ''}" data-act="paid" data-i="${i}">${paid ? 'Paid ✓' : 'Paid?'}</button></span></div>`; }).join('')}
    ${paidTot ? `<p class="hint">Paid ${money(paidTot, b.c)} of ${money(billTot, b.c)}</p>` : ''}
    ${replied ? (list.length ? `<div class="warn fixbox"><b>Check these${unclaimed ? ` (${money(unclaimed, b.c)} unclaimed)` : ''}:</b><p class="hint">Split between whoever claimed it, or assign it to people (shared evenly).</p>${list.map(x => fixRow(b, x)).join('')}</div>` : '<p class="ok">Every item is claimed exactly once ✓</p>') : '<p class="hint">Greyed totals are only the shared items so far.</p>'}
    ${allIn && sumT !== billTot ? `<p class="hint">Rounding: totals are ${money(Math.abs(sumT - billTot), b.c)} ${sumT > billTot ? 'over' : 'under'} the bill.</p>` : ''}
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
  b.items.forEach(it => ((b.pre[it.k] || []).length ? shared : pickable).push(it));
  return `${back}<header><h1>${esc(b.title || 'Split the bill')}</h1><p class="sub">Hi ${esc(b.people[G.me])}. Tick what you had. <button class="link" data-act="changeme">Not you?</button></p></header>
  ${shared.length ? `<h3>Already shared with you</h3>${shared.filter(it => b.pre[it.k].includes(G.me)).map(it => `<div class="card line"><span>${esc(it.n)} <small class="mute">split ${b.pre[it.k].length} ways</small></span><b>${money(Math.round(it.p / b.pre[it.k].length), b.c)}</b></div>`).join('') || '<p class="hint">None of the shared items include you.</p>'}` : ''}
  <h3>What did you have?</h3>
  ${pickable.map(it => { const pk = G.picks.find(x => String(x[0]) === it.k), on = !!pk;
    return `<div class="pick ${on ? 'on' : ''}"><button class="pickbtn" data-act="tick" data-k="${it.k}"><span class="box">${on ? '✓' : ''}</span><span class="n">${esc(it.n)}</span><b>${money(it.p, b.c)}</b></button>
    ${on ? `<div class="split">Split between <button class="step" data-act="dm" data-k="${it.k}">−</button><b>${pk[1]}</b><button class="step" data-act="dp" data-k="${it.k}">+</button> ${pk[1] === 1 ? 'person (just me)' : 'people'} <em>→ ${money(Math.round(it.p / pk[1]), b.c)}</em></div>` : ''}</div>`; }).join('')}
  ${G.sent ? `<div class="card"><h3>Reply ready</h3><p class="hint">Send this message to whoever's collecting the money.</p><textarea readonly rows="3" id="replybox">${esc(G.sent)}</textarea>
    <div class="row"><button class="btn primary" data-act="sharereply">Share</button><button class="btn" data-act="copyreply">Copy</button></div></div>` : ''}
  ${b.extra ? `<p class="hint">Includes your share of ${esc(b.xl || 'extras')} (${money(b.extra, b.c)} total).</p>` : ''}
  ${b.pn && !G.local ? `<div class="card row"><div style="flex:1"><small class="mute">Pay</small><div>${esc(b.pn)}</div></div><button class="btn" data-act="copypay">Copy</button></div>` : ''}
  <div class="bar"><div><small class="mute">You owe</small><div class="amt">${money(tot, b.c)}</div></div>
    <button class="btn primary" data-act="${G.local ? 'savelocal' : 'send'}">${G.local ? 'Save my picks' : 'Send to host'}</button></div>`;
}

// ---------- render + events ----------
function render() {
  const sig = S.guest ? 'g' + S.guest.me : S.step, keep = sig === S._sig, y = window.scrollY; S._sig = sig;
  $('#app').innerHTML = S.guest ? vGuest() : ({ home: vHome, scan: vScan, review: vReview, people: vPeople, assign: vAssign, dash: vDash }[S.step])();
  window.scrollTo(0, keep ? y : 0);
}
async function genLink() {
  S.link = null; const base = location.href.split('#')[0];
  S.link = base + '#b=' + await pack(compact(S.bill)); if (S.step === 'dash' && !S.guest) render();
}
function go(step) { S.step = step; S.err = ''; S.fix = {}; render(); }
function cleanItems() { S.bill.items = S.bill.items.filter(x => x.n.trim() || x.p > 0); S.bill.items.forEach(x => { if (!x.n.trim()) x.n = 'Item'; }); }
function freshKey(b, taken) {
  let k; do { k = Math.random().toString(36).slice(2, 6); } while (b.items.some(x => x.k === k) || (taken || []).some(x => x.k === k)); return k;
}
function withKeys(b, arr) { const out = []; arr.forEach(x => out.push({ ...x, k: freshKey(b, out) })); return out; }
function removePerson(p) {
  const b = S.bill; b.people.splice(p, 1);
  const fix = a => a.filter(x => x !== p).map(x => x > p ? x - 1 : x);
  for (const k of Object.keys(b.pre)) { b.pre[k] = fix(b.pre[k]); if (!b.pre[k].length) delete b.pre[k]; }
  const shift = o => { const nr = {}; for (const k of Object.keys(o)) { const i = +k; if (i !== p) nr[i > p ? i - 1 : i] = o[k]; } return nr; };
  b.replies = shift(b.replies); b.paid = shift(b.paid);
}
function summaryText() {
  const b = S.bill, r = computeTotals(b, b.replies);
  return `${b.title || 'Bill'} (${money(sumItems(b) + b.extra, b.c)})\n` + b.people.map((p, i) => `${p}: ${money(r.totals[i], b.c)}${b.paid[i] ? ' (paid)' : b.replies[i] == null ? ' (not replied yet, shared items only)' : ''}`).join('\n') + (b.pn ? `\nPay: ${b.pn}` : '');
}
async function restore(f) {
  if (!f) return;
  try {
    const o = JSON.parse(await f.text()); if (!o || !Array.isArray(o.bills)) throw new Error('bad');
    let n = 0;
    for (const x of o.bills) if (x && typeof x.id === 'string' && Array.isArray(x.items) && Array.isArray(x.people) && !S.bills.some(y => y.id === x.id)) { S.bills.push(migrate(x)); n++; }
    persist(); render(); toast(n ? `Restored ${n} bill${n > 1 ? 's' : ''}` : 'Nothing new to restore');
  } catch (e) { toast('That file is not a bill backup'); }
}
function exportBills() {
  const blob = new Blob([JSON.stringify({ app: 'billsplit', v: 1, bills: S.bills })], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'billsplit-backup.json';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
    b.items = withKeys(b, r.items); b.extra = r.extra; b.xl = r.xl; b.total = r.total; b.raw = data.text;
    if (!b.items.length) b.items = withKeys(b, [{ n: '', p: 0 }]);
    S.busy = ''; if (!S.bills.includes(b)) S.bills.unshift(b); persist(); go('review');
  } catch (e) {
    S.busy = ''; S.err = e && e.message === 'offline' ? 'Could not download the reader. Connect to the internet and try again, or enter items manually.' : 'Could not read that photo. Try a flatter, brighter shot, or enter items manually.'; render();
  }
}

document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'file') return scan(t.files[0]);
  if (t.id === 'restore') return restore(t.files[0]);
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
  const b = S.bill, G = S.guest, i = +el.dataset.i, k = el.dataset.k;
  const pk = () => G.picks.find(x => String(x[0]) === k);
  switch (a) {
    case 'new': S.bill = newBill(); go('scan'); break;
    case 'home': S.bill = null; S.guest = null; go('home'); break;
    case 'open': S.bill = S.bills[i]; if (S.bill.people.length >= 2 && S.bill.items.length) { go('dash'); genLink(); } else go('review'); break;
    case 'manual': b.items = withKeys(b, [{ n: '', p: 0 }]); if (!S.bills.includes(b)) S.bills.unshift(b); persist(); go('review'); break;
    case 'additem': b.items.push({ n: '', p: 0, k: freshKey(b) }); persist(); render(); { const r = document.querySelectorAll('input[data-bind=iname]'); r[r.length - 1].focus(); } break;
    case 'del': {
      const key = b.items[i].k; b.items.splice(i, 1); delete b.pre[key];
      for (const pi of Object.keys(b.replies)) b.replies[pi] = b.replies[pi].filter(x => String(x[0]) !== key);
      persist(); render(); break;
    }
    case 'tip': {
      const pct = +el.dataset.pct; b.extra = Math.round(sumItems(b) * pct / 100);
      if (pct && (!b.xl.trim() || /tip/i.test(b.xl))) b.xl = 'Tip'; persist(); render(); break;
    }
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
    case 'pre': {
      const pi = +el.dataset.pi, a2 = b.pre[k] || [];
      const n = a2.includes(pi) ? a2.filter(x => x !== pi) : [...a2, pi].sort((x, y) => x - y);
      if (n.length) b.pre[k] = n; else delete b.pre[k]; S.fix[k] = 1; persist(); render(); break;
    }
    case 'preall':
      if ((b.pre[k] || []).length === b.people.length) delete b.pre[k]; else b.pre[k] = b.people.map((_, x) => x);
      S.fix[k] = 1; persist(); render(); break;
    case 'fixsplit': {
      const cl = claimants(b, k);
      cl.forEach(pi => b.replies[pi].forEach(x => { if (String(x[0]) === k) x[1] = cl.length; }));
      S.fix[k] = 1; persist(); render(); break;
    }
    case 'paid': if (b.paid[i]) delete b.paid[i]; else b.paid[i] = true; persist(); render(); break;
    case 'copylink': b.sentSig = sigOf(b); persist(); copy(S.link); render(); break;
    case 'sharelink': {
      const text = `Split "${b.title || 'the bill'}": open this, pick your name and tick what you had.\n${S.link}`;
      b.sentSig = sigOf(b); persist(); render(); share(b.title || 'Split the bill', text); break;
    }
    case 'fillmine': startGuest(b, true); render(); break;
    case 'addreply': {
      const codes = [...($('#paste').value || '').matchAll(/BSR:([A-Za-z0-9_-]+)/g)].map(m => m[1]);
      if (!codes.length) return toast('No reply code found');
      const added = []; let bad = 0;
      for (const c of codes) {
        try {
          const o = await unpack(c);
          if (o.i !== b.id || !b.people[o.p] || !Array.isArray(o.s)) { bad++; continue; }
          b.replies[o.p] = o.s.filter(Array.isArray).map(x => [String(x[0]), Math.max(1, x[1] | 0)]); added.push(b.people[o.p]);
        } catch (e) { bad++; }
      }
      persist(); render();
      toast(added.length ? `Added ${[...new Set(added)].join(', ')}${bad ? ` (${bad} skipped)` : ''}` : 'Could not read those replies');
      break;
    }
    case 'summary': copy(summaryText()); break;
    case 'export': exportBills(); break;
    case 'delbill': if (confirm('Delete this bill from your phone?')) { S.bills.splice(S.bills.indexOf(b), 1); persist(); S.bill = null; go('home'); } break;
    // guest
    case 'me': G.me = i; G.picks = G.local ? (G.bill.replies[i] || []).map(x => x.slice()) : G.picks; gSave(); render(); break;
    case 'changeme': G.me = null; G.picks = []; G.sent = ''; gSave(); render(); break;
    case 'tick': { const x = G.picks.findIndex(y => String(y[0]) === k); if (x >= 0) G.picks.splice(x, 1); else G.picks.push([k, 1]); G.sent = ''; gSave(); render(); break; }
    case 'dm': { const p = pk(); p[1] = Math.max(1, p[1] - 1); G.sent = ''; gSave(); render(); break; }
    case 'dp': { const p = pk(); p[1] = Math.min(G.bill.people.length, p[1] + 1); G.sent = ''; gSave(); render(); break; }
    case 'send': {
      const code = await pack({ i: G.bill.id, p: G.me, s: G.picks });
      G.sent = `Bill reply: ${G.bill.title || 'Bill'}, ${G.bill.people[G.me]}\nBSR:${code}`; render();
      share('Bill reply', G.sent); break;
    }
    case 'sharereply': share('Bill reply', G.sent); break;
    case 'copyreply': copy(G.sent); break;
    case 'copypay': copy(G.bill.pn); break;
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
function showUpdate() {
  if ($('.upd')) return;
  const d = document.createElement('button'); d.className = 'upd'; d.textContent = 'New version available. Tap to refresh';
  d.onclick = () => location.reload(); document.body.appendChild(d);
}
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) showUpdate(); });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
}
