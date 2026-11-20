// Public discovery files for crawlers and assistants.
// Built at startup from the same page list the site guide tool uses (public/page-tools.js
// SITE_PAGES) and from the WebMCP tool registrations in page-tools.js and color-tools.js.
// scripts/build-site-index.mjs only walks the widget HTML, so it cannot list the top-level pages.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC_SITE = "https://copilot-sdk.demo.curiosta.com";

// Stable order for the ten public pages. Any new page added to SITE_PAGES is appended.
const PAGE_ORDER = ["/", "/gotchas", "/architecture", "/demos", "/widget/", "/widget/webmcp.html", "/widget/storage.html", "/widget/xss.html", "/widget/openrouter.html", "/widget/privacy.html"];

const TOOL_PAGE = {
  get_site_guide: "/",
  get_landing_guide: "/",
  get_browser_reveal: "/",
  get_connection_reveal: "/",
  get_atlas_summary: "/gotchas",
  lookup_atlas_technique: "/gotchas",
  lookup_gotcha: "/gotchas",
  get_architecture_guide: "/architecture",
  get_demo_catalog: "/demos",
  read_demo_state: "/demos",
  get_page_guide: "/widget/",
  set_color: "/widget/",
  get_color: "/widget/",
  reset_color: "/widget/",
};

function loadBrowserScript(rel) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), ctx, { filename: rel });
  return ctx;
}

let catalog = null;
function loadCatalog() {
  if (catalog) return catalog;
  const page = loadBrowserScript("public/page-tools.js").__btwPage;
  const color = loadBrowserScript("public/widget/color-tools.js").__btwColor;
  if (!page || !Array.isArray(page.SITE_PAGES) || !page.SPECS) throw new Error("page tools did not export the public page list");
  if (!color || !Array.isArray(color.TOOL_SPECS)) throw new Error("color tools did not export their registrations");
  catalog = { pages: page.SITE_PAGES, specs: page.SPECS, colorSpecs: color.TOOL_SPECS };
  return catalog;
}

export function absoluteUrl(pathname) {
  const pathOnly = String(pathname || "/");
  if (pathOnly === "/") return PUBLIC_SITE + "/";
  return PUBLIC_SITE + (pathOnly.startsWith("/") ? pathOnly : "/" + pathOnly);
}

export function publicPages() {
  const pages = loadCatalog().pages.filter((p) => p && p.path && !/chrome-eval/i.test(p.path));
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const ordered = [];
  for (const path of PAGE_ORDER) {
    if (byPath.has(path)) { ordered.push(byPath.get(path)); byPath.delete(path); }
  }
  for (const page of pages) if (byPath.has(page.path)) { ordered.push(page); byPath.delete(page.path); }
  return ordered;
}

function firstSentence(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  // A period inside a code such as AML.T0051 is not the end of the sentence.
  const m = s.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : s).trim();
}

export function webmcpTools() {
  const { specs, colorSpecs } = loadCatalog();
  const tools = [];
  for (const spec of [...Object.values(specs), ...colorSpecs]) {
    if (!spec || !spec.name || !spec.description) continue;
    tools.push({
      name: spec.name,
      line: firstSentence(spec.description),
      path: TOOL_PAGE[spec.name] || "/",
    });
  }
  return tools;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function robotsTxt() {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "",
    "Sitemap: " + absoluteUrl("/sitemap.xml"),
    "",
  ].join("\n");
}

export function sitemapXml() {
  const urls = publicPages().map((p) => "  <url><loc>" + xmlEscape(absoluteUrl(p.path)) + "</loc></url>");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

function mdLink(label, url) {
  const text = String(label).replace(/[\[\]]/g, "");
  return "[" + text + "](" + url + ")";
}

export function llmsTxt() {
  const pages = publicPages();
  const tools = webmcpTools();
  const pageLines = pages.map((p) => "- " + mdLink(p.title, absoluteUrl(p.path)) + ": " + String(p.summary || "").replace(/\s+/g, " ").trim());
  const toolLines = tools.map((t) => "- " + mdLink(t.name, absoluteUrl(t.path)) + ": " + t.line);
  return [
    "# Browser Tutor",
    "",
    "> This site shows what your browser tells a website, and how you can keep more of that private.",
    "",
    "You can read the public pages without signing in. WebMCP lets a page offer tools to an assistant in the browser. Most of these tools only read public text. The color tools change an example color on the widget home page. They do not read cookies, keys, or saved chat.",
    "",
    "## Pages",
    "",
    ...pageLines,
    "",
    "## WebMCP tools",
    "",
    ...toolLines,
    "",
  ].join("\n");
}
