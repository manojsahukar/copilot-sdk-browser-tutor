// Build-time crawler for a STATIC site: reads HTML files and emits site-index.json
// (url, title, headings, cleaned text chunks) for the widget's in-browser BM25 retrieval.
// No backend and no runtime crawl — run this in your build / GitHub Actions step.
//
//   node scripts/build-site-index.mjs <dir> [--base /path/] [--out file.json]
//
// Example (pilot): node scripts/build-site-index.mjs public/widget --base /widget/ --out public/widget/site-index.json
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--")) || "public/widget";
const getOpt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const base = getOpt("--base", "/" + path.basename(dir) + "/").replace(/\/?$/, "/");
const out = getOpt("--out", path.join(dir, "site-index.json"));
const CHUNK = Number(getOpt("--chunk", "700"));

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " ", mdash: "—", "#x27": "'" };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isNaN(n) ? m : String.fromCodePoint(n); }
  return ENT[e.toLowerCase()] ?? m;
});
const clean = (s) => decode(s.replace(/<[^>]+>/g, " ")).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();

function urlFor(file) {
  const rel = path.relative(dir, file).replace(/\\/g, "/");
  if (/(^|\/)index\.html$/i.test(rel)) return base + rel.replace(/index\.html$/i, "");
  return base + rel;
}

function parse(html, url) {
  // Prefer <article>, then <main>, then <body>.
  const pick = (re) => { const m = html.match(re); return m ? m[1] : null; };
  let body = pick(/<article[^>]*>([\s\S]*?)<\/article>/i) || pick(/<main[^>]*>([\s\S]*?)<\/main>/i) || pick(/<body[^>]*>([\s\S]*?)<\/body>/i) || html;
  // Drop non-content blocks.
  body = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
             .replace(/<nav[\s\S]*?<\/nav>/gi, " ").replace(/<footer[\s\S]*?<\/footer>/gi, " ").replace(/<aside[\s\S]*?<\/aside>/gi, " ");
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1M = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = clean(titleM ? titleM[1] : (h1M ? h1M[1] : url));

  // Walk headings (h1-h3) and the text between them to form heading-scoped chunks.
  const headings = [];
  const parts = [];
  const re = /<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi;
  let last = 0, lastHeading = title, m;
  const push = (heading, text) => {
    text = clean(text);
    if (!text) return;
    // split long text into ~CHUNK pieces on sentence/paragraph boundaries
    let buf = "";
    text.split(/(?<=[.!?])\s+/).forEach((sent) => {
      if ((buf + " " + sent).length > CHUNK && buf) { parts.push({ heading, text: buf.trim() }); buf = sent; }
      else buf += (buf ? " " : "") + sent;
    });
    if (buf.trim()) parts.push({ heading, text: buf.trim() });
  };
  while ((m = re.exec(body))) {
    push(lastHeading, body.slice(last, m.index));
    lastHeading = clean(m[2]); headings.push(lastHeading);
    last = re.lastIndex;
  }
  push(lastHeading, body.slice(last));
  return { url, title, headings, parts };
}

function walk(d) {
  const files = [];
  for (const name of fs.readdirSync(d)) {
    const full = path.join(d, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) files.push(...walk(full));
    else if (/\.html?$/i.test(name)) files.push(full);
  }
  return files;
}

const files = walk(dir).sort();
const pages = [];
const chunks = [];
for (const file of files) {
  const html = fs.readFileSync(file, "utf8");
  const url = urlFor(file);
  const { title, headings, parts } = parse(html, url);
  pages.push({ url, title, headings });
  parts.forEach((p) => chunks.push({ url, title, heading: p.heading, text: p.text }));
}
const index = { generatedAt: new Date().toISOString(), base, pages, chunks };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(index));
console.log(`Indexed ${pages.length} pages, ${chunks.length} chunks -> ${out} (${fs.statSync(out).size} bytes)`);
