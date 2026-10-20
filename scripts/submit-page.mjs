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

export function renderMarkdown(tabs, version) {
  const out = [
    `# Chrome Web Store submission: GitHub Repo Navigator ${version}`,
    '',
    'One section per Developer Dashboard tab, in order. Each field is under its exact label; paste the block below it.',
    'SUBMIT.html has the same content with Copy buttons.',
    '',
  ];
  tabs.forEach((tab, i) => {
    out.push(`## ${i + 1}. ${tab.tab} tab`, '');
    if (tab.intro) out.push(tab.intro, '');
    for (const f of tab.fields) {
      out.push(`### ${f.label}${f.required ? ' *' : ''}`, '');
      if (f.kind === 'text') out.push(`Paste (${num(chars(f.value))}${f.limit ? ` / ${num(f.limit)}` : ''} characters):`, '', '```text', f.value, '```', '');
      if (f.kind === 'choice') out.push(`Choose: **${f.value}**`, '');
      if (f.kind === 'info') out.push(f.value, '');
      if (f.kind === 'file') out.push(...f.files.map((p) => `- Upload \`${p}\``), '');
      if (f.kind === 'checks') out.push(...f.options.map(([name, on, why]) => `- [${on ? 'x' : ' '}] ${name}${why ? ` (${why})` : ''}`), '');
      if (f.note) out.push(`> ${f.note}`, '');
    }
  });
  return out.join('\n');
}

export function renderHtml(tabs, version) {
  let n = 0;
  const field = (f) => {
    const id = `f${++n}`;
    const label = `<h3>${esc(f.label)}${f.required ? '<span class="req" title="Required">*</span>' : ''}</h3>`;
    let body = '';
    if (f.kind === 'text') {
      const count = `${num(chars(f.value))}${f.limit ? ` / ${num(f.limit)}` : ''} characters`;
      const rows = Math.min(24, Math.max(2, f.value.split('\n').length + Math.floor(f.value.length / 110)));
      body =
        `<textarea id="${id}" readonly rows="${rows}" spellcheck="false">${esc(f.value)}</textarea>` +
        `<div class="bar"><span class="muted">${count}</span><button type="button" data-copy="${id}">Copy</button></div>`;
    } else if (f.kind === 'choice') {
      body = `<p><span class="kind">Choose</span> <strong>${esc(f.value)}</strong></p>`;
    } else if (f.kind === 'info') {
      body = `<p class="muted">${esc(f.value)}</p>`;
    } else if (f.kind === 'file') {
      body = `<p><span class="kind">Upload</span></p><ul class="files">${f.files.map((p) => `<li><a href="${esc(p)}" target="_blank">${esc(p)}</a></li>`).join('')}</ul>`;
    } else if (f.kind === 'checks') {
      body = `<ul class="checks">${f.options
        .map(
          ([name, on, why]) =>
            `<li class="${on ? 'on' : 'off'}"><span class="box" aria-hidden="true">${on ? '✓' : ''}</span><span>${on ? '<strong>Tick:</strong>' : 'Leave unticked:'} ${esc(name)}${why ? `<br><span class="muted">${esc(why)}</span>` : ''}</span></li>`,
        )
        .join('')}</ul>`;
    }
    const note = f.note ? `<p class="note">${esc(f.note)}</p>` : '';
    return `<section class="field">${label}${body}${note}</section>`;
  };
  const nav = tabs.map((t, i) => `<a href="#tab${i}">${i + 1}. ${esc(t.tab)}</a>`).join('');
  const sections = tabs
    .map(
      (t, i) =>
        `<section class="tab" id="tab${i}"><h2><span class="num">${i + 1}</span>${esc(t.tab)} tab</h2>${t.intro ? `<p class="muted">${esc(t.intro)}</p>` : ''}${t.fields.map(field).join('')}</section>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Store submission: GitHub Repo Navigator ${esc(version)}</title>
<style>
:root{--bg:#0d1117;--card:#151b23;--border:#3d444d;--fg:#f0f6fc;--muted:#9198a1;--accent:#4493f8;--ok:#3fb950;--code:#010409;color-scheme:dark}
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
</style></head><body>
<header><h1>Chrome Web Store submission: GitHub Repo Navigator ${esc(version)}</h1><nav>${nav}</nav></header>
<main><p class="muted">One section per Developer Dashboard tab, in order. Each field is shown under its exact label: click <strong>Copy</strong> and paste it into that field. Files are in this folder (the links open them).</p>${sections}</main>
<script>
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
