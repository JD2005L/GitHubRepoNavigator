// Renders the store submission (scripts/store-listing.mjs) as SUBMIT.html (copy buttons) and SUBMIT.md.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const chars = (s) => [...s].length;
const num = (n) => n.toLocaleString('en-US');

/** Fails the build when a value would not fit its dashboard field. */
export function checkLimits(tabs) {
  for (const tab of tabs) {
    for (const f of tab.fields) {
      if (f.kind === 'text' && f.limit && chars(f.value) > f.limit) throw new Error(`${tab.tab} → ${f.label}: ${chars(f.value)} characters, limit ${f.limit}`);
    }
  }
}

/** A field's content as SUBMIT.md shows it, without notes: what the listing history compares between releases. */
export function fieldBody(f) {
  if (f.kind === 'text') return f.value;
  if (f.kind === 'choice') return `Choose: **${f.value}**`;
  if (f.kind === 'file') return f.files.map((p) => `- Upload \`${p}\``).join('\n');
  if (f.kind === 'checks') return f.options.map(([name, on, why]) => `- [${on ? 'x' : ' '}] ${name}${why ? ` (${why})` : ''}`).join('\n');
  return f.value;
}

const lastRelease = (history, version) => history.versions.filter((v) => v !== version).at(-1) ?? null;
/** "New in 1.2.0", "Changed in 1.4.0" (this release) or "Last changed in 1.2.0". */
export function changedLabel(h, version, first) {
  if (h.since === h.added && h.added !== first) return `New in ${h.since}`;
  return h.since === version ? `Changed in ${h.since}` : `Last changed in ${h.since}`;
}

export function renderMarkdown(tabs, version, history) {
  const previous = lastRelease(history, version);
  const changed = tabs.flatMap((t) => t.fields.filter((f) => history.fields[`${t.tab} › ${f.label}`].since === version).map((f) => `- ${t.tab} › ${f.label}`));
  const out = [
    `# Chrome Web Store submission: GitHub Repo Navigator ${version}`,
    '',
    'One section per Developer Dashboard tab, in order. Each field is under its exact label; paste the block below it.',
    'SUBMIT.html has the same content with Copy buttons, and can highlight changes since any earlier release.',
    '',
    ...(previous ? [`## Changed since ${previous}`, '', ...changed, ''] : []),
  ];
  tabs.forEach((tab, i) => {
    out.push(`## ${i + 1}. ${tab.tab} tab`, '');
    if (tab.intro) out.push(tab.intro, '');
    for (const f of tab.fields) {
      const h = history.fields[`${tab.tab} › ${f.label}`];
      out.push(`### ${f.label}${f.required ? ' *' : ''}`, '');
      if (f.kind === 'text') out.push(`Paste (${num(chars(f.value))}${f.limit ? ` / ${num(f.limit)}` : ''} characters):`, '', '```text', f.value, '```', '');
      else out.push(fieldBody(f), '');
      if (f.note) out.push(`> ${f.note}`, '');
      out.push(`_${changedLabel(h, version, history.versions[0])}_`, '');
    }
  });
  return out.join('\n');
}

/**
 * SUBMIT.html's script for "what changed since the version in the dashboard": highlights, the summary list and line
 * diffs of text fields. Plain ES2020 in a String.raw, so no backticks or ${ inside.
 */
const CLIENT = String.raw`
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const after = (since, base) => !base || cmp(since, base) > 0;
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
// Line diff (longest common subsequence); long unchanged runs fold to one line of context on each side.
function diff(a, b) {
  const x = a.split('\n'), y = b.split('\n'), m = x.length, n = y.length;
  const L = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && x[i] === y[j]) { ops.push(['same', x[i]]); i++; j++; }
    else if (i < m && (j >= n || L[i + 1][j] >= L[i][j + 1])) ops.push(['del', x[i++]]);
    else ops.push(['add', y[j++]]);
  }
  const near = (k) => (ops[k - 1] && ops[k - 1][0] !== 'same') || (ops[k + 1] && ops[k + 1][0] !== 'same');
  const out = [];
  ops.forEach((op, k) => {
    if (op[0] !== 'same' || near(k)) out.push('<span class="' + op[0] + '">' + (escHtml(op[1]) || ' ') + '</span>');
    else if (out[out.length - 1] !== '<span class="gap">…</span>') out.push('<span class="gap">…</span>');
  });
  return out.join('');
}
function apply(base) {
  const changed = [];
  for (const el of document.querySelectorAll('.field[data-key]')) {
    const info = HISTORY.fields[el.dataset.key];
    const on = after(el.dataset.since, base);
    el.classList.toggle('changed', on);
    if (on) changed.push(el);
    for (const li of el.querySelectorAll('li[data-since]')) li.classList.toggle('changed', after(li.dataset.since, base));
    const box = el.querySelector('details.diff');
    if (!box) continue;
    box.hidden = !on || !base;
    if (box.hidden) continue;
    const olds = Object.keys(info.texts || {}).filter((v) => cmp(v, base) <= 0).sort(cmp);
    const old = olds.length ? info.texts[olds[olds.length - 1]] : null;
    box.querySelector('summary').textContent = old === null ? 'New field since ' + base : 'What changed since ' + base;
    box.querySelector('pre').innerHTML = old === null ? '<span class="add">(all of it)</span>' : diff(old, el.querySelector('textarea').value);
  }
  const summary = document.getElementById('summary');
  summary.hidden = !base;
  document.getElementById('baseline-count').textContent = base ? changed.length + ' field' + (changed.length === 1 ? '' : 's') + ' to update' : 'fill in every field';
  if (base) {
    summary.innerHTML = '<h2>Update ' + changed.length + ' field' + (changed.length === 1 ? '' : 's') + ' (changed since ' + escHtml(base) + ')</h2><ul>' +
      changed.map((el) => '<li><a href="#' + el.id + '">' + escHtml(el.dataset.key) + '</a> <span class="muted">' + escHtml(el.querySelector('.since').dataset.label) + '</span></li>').join('') + '</ul>';
  }
}
const select = document.getElementById('baseline');
try { const saved = localStorage.getItem('submit.baseline'); if (saved !== null && [...select.options].some((o) => o.value === saved)) select.value = saved; } catch {}
select.addEventListener('change', () => { try { localStorage.setItem('submit.baseline', select.value); } catch {} apply(select.value); });
apply(select.value);
`;

export function renderHtml(tabs, version, history) {
  let n = 0;
  const first = history.versions[0];
  const field = (f, tab) => {
    const id = `f${++n}`;
    const key = `${tab} › ${f.label}`;
    const h = history.fields[key];
    const badge = `<span class="since" data-label="${esc(changedLabel(h, version, first))}">${esc(changedLabel(h, version, first))}</span>`;
    const label = `<h3>${esc(f.label)}${f.required ? '<span class="req" title="Required">*</span>' : ''}${badge}</h3>`;
    let body = '';
    if (f.kind === 'text') {
      const count = `${num(chars(f.value))}${f.limit ? ` / ${num(f.limit)}` : ''} characters`;
      const rows = Math.min(24, Math.max(2, f.value.split('\n').length + Math.floor(f.value.length / 110)));
      body =
        `<textarea id="${id}" readonly rows="${rows}" spellcheck="false">${esc(f.value)}</textarea>` +
        `<div class="bar"><span class="muted">${count}</span><button type="button" data-copy="${id}">Copy</button></div>` +
        `<details class="diff" hidden><summary></summary><pre></pre></details>`;
    } else if (f.kind === 'choice') {
      body = `<p><span class="kind">Choose</span> <strong>${esc(f.value)}</strong></p>`;
    } else if (f.kind === 'info') {
      body = `<p class="muted">${esc(f.value)}</p>`;
    } else if (f.kind === 'file') {
      body = `<p><span class="kind">Upload</span></p><ul class="files">${f.files
        .map((p) => `<li data-since="${esc(h.files[p] ?? version)}"><a href="${esc(p)}" target="_blank">${esc(p)}</a> <span class="file-since">${esc(h.files[p] === version ? `changed in ${version}` : `last changed in ${h.files[p]}`)}</span></li>`)
        .join('')}</ul>`;
    } else if (f.kind === 'checks') {
      body = `<ul class="checks">${f.options
        .map(
          ([name, on, why]) =>
            `<li class="${on ? 'on' : 'off'}"><span class="box" aria-hidden="true">${on ? '✓' : ''}</span><span>${on ? '<strong>Tick:</strong>' : 'Leave unticked:'} ${esc(name)}${why ? `<br><span class="muted">${esc(why)}</span>` : ''}</span></li>`,
        )
        .join('')}</ul>`;
    }
    const note = f.note ? `<p class="note">${esc(f.note)}</p>` : '';
    return `<section class="field" id="${id}-field" data-key="${esc(key)}" data-since="${esc(h.since)}">${label}${body}${note}</section>`;
  };
  const nav = tabs.map((t, i) => `<a href="#tab${i}">${i + 1}. ${esc(t.tab)}</a>`).join('');
  const sections = tabs
    .map(
      (t, i) =>
        `<section class="tab" id="tab${i}"><h2><span class="num">${i + 1}</span>${esc(t.tab)} tab</h2>${t.intro ? `<p class="muted">${esc(t.intro)}</p>` : ''}${t.fields.map((f) => field(f, t.tab)).join('')}</section>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Store submission: GitHub Repo Navigator ${esc(version)}</title>
<style>
:root{--bg:#0d1117;--card:#151b23;--border:#3d444d;--fg:#f0f6fc;--muted:#9198a1;--accent:#4493f8;--ok:#3fb950;--code:#010409;--chg:#e3b341;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 "Segoe UI",system-ui,-apple-system,sans-serif}
header{position:sticky;top:0;z-index:2;background:rgba(13,17,23,.95);border-bottom:1px solid var(--border);padding:12px 24px}
header h1{font-size:18px;margin:0 0 6px}
nav{display:flex;flex-wrap:wrap;gap:6px}
nav a{color:var(--fg);text-decoration:none;font-size:13px;padding:4px 10px;border:1px solid var(--border);border-radius:999px}
nav a:hover{border-color:var(--accent)}
main{max-width:920px;margin:0 auto;padding:24px 24px 80px}
.tab{margin:0 0 36px;scroll-margin-top:110px}
.tab h2{font-size:22px;margin:0 0 10px;display:flex;align-items:center;gap:10px}
.num{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--accent);color:#fff;font-size:15px}
.field{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:10px 0}
.field h3{font-size:15px;margin:0 0 8px}
.req{color:#f85149;margin-left:3px}
.muted{color:var(--muted)}
.kind{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-right:4px}
textarea{width:100%;resize:vertical;background:var(--code);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:10px;font:13px/1.5 ui-monospace,Consolas,monospace}
.bar{display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:13px}
button{font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:6px;padding:6px 14px;cursor:pointer}
button.done{background:var(--ok)}
ul.files,ul.checks{margin:0;padding:0;list-style:none}
ul.files li{margin:3px 0}
a{color:var(--accent)}
ul.checks li{display:flex;gap:10px;align-items:flex-start;margin:6px 0}
.box{flex:none;width:18px;height:18px;margin-top:2px;border:1px solid var(--border);border-radius:4px;display:grid;place-items:center;font-size:13px;font-weight:700}
li.on .box{background:var(--ok);border-color:var(--ok);color:#fff}
li.off{color:var(--muted)}
.note{margin:8px 0 0;font-size:13px;color:var(--muted);border-left:3px solid var(--border);padding-left:10px}
.since{margin-left:10px;font-size:12px;font-weight:500;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:1px 8px;vertical-align:2px}
.file-since{font-size:12px;color:var(--muted)}
.field.changed{border-color:var(--chg);box-shadow:inset 4px 0 0 var(--chg)}
.field.changed .since,li.changed .file-since{color:#111;background:var(--chg);border-color:var(--chg);font-weight:600}
li.changed .file-since{border-radius:999px;padding:1px 8px}
.baseline{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:8px 0 0;font-size:13px}
.baseline select{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--border);border-radius:6px;padding:3px 6px}
.summary{background:var(--card);border:1px solid var(--chg);border-radius:10px;padding:12px 16px;margin:0 0 24px}
.summary h2{font-size:16px;margin:0 0 6px}
.summary ul{margin:0;padding-left:20px}
.summary li{margin:2px 0}
details.diff{margin-top:8px;font-size:13px}
details.diff summary{cursor:pointer;color:var(--chg);font-weight:600}
details.diff pre{margin:6px 0 0;padding:8px 10px;background:var(--code);border:1px solid var(--border);border-radius:6px;white-space:pre-wrap;font:12px/1.5 ui-monospace,Consolas,monospace}
.add{display:block;background:rgba(63,185,80,.15);color:#7ee787}
.del{display:block;background:rgba(248,81,73,.15);color:#ffa198;text-decoration:line-through}
.gap{display:block;color:var(--muted)}
</style></head><body>
<header><h1>Chrome Web Store submission: GitHub Repo Navigator ${esc(version)}</h1><nav>${nav}</nav>
<div class="baseline"><label>The dashboard has <select id="baseline">${history.versions
    .filter((v) => v !== version)
    .reverse()
    .map((v) => `<option value="${esc(v)}">${esc(v)}</option>`)
    .join('')}<option value="">nothing yet (first submission)</option></select></label><span class="muted" id="baseline-count"></span></div></header>
<main><p class="muted">One section per Developer Dashboard tab, in order. Each field is shown under its exact label: click <strong>Copy</strong> and paste it into that field. Files are in this folder (the links open them). Every field says which release last changed it; fields changed since the version chosen above are highlighted, and text fields show what changed.</p><section class="summary" id="summary" hidden></section>${sections}</main>
<script>
const HISTORY = ${JSON.stringify(history).replace(/</g, '\\u003c')};
${CLIENT}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-copy]');
  if (!b) return;
  const t = document.getElementById(b.dataset.copy);
  try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand('copy'); }
  b.textContent = 'Copied';
  b.classList.add('done');
  setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1500);
});
</script></body></html>
`;
}
