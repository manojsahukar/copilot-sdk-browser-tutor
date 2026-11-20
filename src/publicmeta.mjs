// Public discovery files for crawlers and assistants.
// Built at startup from the same page list the site guide tool uses (public/page-tools.js
// SITE_PAGES) and from the WebMCP tool registrations in page-tools.js and color-tools.js.
// scripts/build-site-index.mjs only walks the widget HTML, so it cannot list the top-level pages.
// /.well-known/webmcp is a discovery aid. It is not a formal standard. The live tools are the ones each page registers.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC_SITE = "https://copilot-sdk.demo.curiosta.com";

// Stable order for the ten public pages. Any new page added to SITE_PAGES is appended.
const PAGE_ORDER = ["/", "/gotchas", "/architecture", "/demos", "/widget/", "/widget/webmcp.html", "/widget/storage.html", "/widget/xss.html", "/widget/openrouter.html", "/widget/privacy.html"];

// Declarative form tools. The same strings are the toolname, tooldescription, toolaction,
// and toolparamdescription attributes in the page HTML.
export const FIND_PAGE_TOOL = {
  name: "find_site_page",
  description: "Find a public page on this site by words in its title or summary.",
  toolaction: "Search the public pages and show the matching titles and links on this page. This only reads the public page list.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      q: { type: "string", maxLength: 80, description: "Words from a page title or summary, such as privacy or color." },
    },
  },
  annotations: { readOnlyHint: true, changesPage: false, consequentialHint: false },
};
export const SET_COLOR_FORM_TOOL = {
  name: "set_color_form",
  description: "Set the example color on this page. The swatch starts at #1f6feb. Use a hex color or an allowed CSS color name.",
  toolaction: "Change the example swatch after a person confirms. A direct set_color or reset_color tool call still applies at once.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["color"],
    properties: {
      color: { type: "string", maxLength: 32, description: "A hex color such as #ff8800 or #f80, or a CSS color name such as teal. The swatch starts at #1f6feb. #3366ff is only a sample." },
      picked: { type: "string", description: "A hex color from the picker. It fills the color box. The swatch starts at #1f6feb." },
    },
  },
  annotations: { readOnlyHint: false, changesPage: true, consequentialHint: false },
};

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
  if (typeof page.specList !== "function" || typeof page.searchPages !== "function" || typeof page.hints !== "function") {
    throw new Error("page tools did not export the guide helpers");
  }
  if (typeof color.annotationsFor !== "function") throw new Error("color tools did not export annotations");
  catalog = {
    pages: page.SITE_PAGES,
    specs: page.SPECS,
    colorSpecs: color.TOOL_SPECS,
    specList: page.specList,
    hints: page.hints,
    searchPages: page.searchPages,
    annotationsFor: color.annotationsFor,
  };
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

export function searchPublicPages(query) {
  return loadCatalog().searchPages(query);
}

function copyJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function manifestTool(spec, changesPage, source) {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: copyJson(spec.inputSchema),
    annotations: {
      readOnlyHint: !changesPage,
      changesPage: !!changesPage,
      consequentialHint: false,
    },
    source: source,
  };
}

function markersFor(pathname) {
  if (pathname === "/") return [{ landing: true }, { probe: true }];
  if (pathname === "/gotchas") return [{ gotchas: true }];
  if (pathname === "/architecture") return [{ architecture: true }];
  if (pathname === "/demos") return [{ demos: true }];
  if (String(pathname).startsWith("/widget")) return [{ widget: true }];
  return [{}];
}

function toolsForPath(pathname) {
  const { specList, colorSpecs } = loadCatalog();
  const tools = [];
  const seen = new Set();
  const add = (tool) => {
    if (!tool || seen.has(tool.name)) return;
    seen.add(tool.name);
    tools.push(tool);
  };
  for (const markers of markersFor(pathname)) {
    for (const spec of specList(markers)) add(manifestTool(spec, false, "imperative"));
  }
  if (pathname === "/widget/") {
    for (const spec of colorSpecs) add(manifestTool(spec, !spec.readOnly, "imperative"));
  }
  const find = manifestTool(FIND_PAGE_TOOL, false, "declarative");
  find.toolaction = FIND_PAGE_TOOL.toolaction;
  add(find);
  if (pathname === "/widget/") {
    const colorForm = manifestTool(SET_COLOR_FORM_TOOL, true, "declarative");
    colorForm.toolaction = SET_COLOR_FORM_TOOL.toolaction;
    add(colorForm);
  }
  return tools;
}

export function webmcpManifest() {
  const pages = publicPages().map((p) => {
    const page = {
      url: absoluteUrl(p.path),
      path: p.path,
      title: p.title,
      description: String(p.summary || "").replace(/\s+/g, " ").trim(),
      tools: toolsForPath(p.path),
    };
    if (p.path === "/") page.note = "Signed-out visitors get the site guide and the landing guide. Signed-in visitors also get the browser and connection tools.";
    return page;
  });
  return {
    name: "Browser Tutor",
    description: "This site shows what your browser tells a website, and how you can keep more of that private.",
    url: PUBLIC_SITE + "/",
    version: "1",
    spec: "WebMCP discovery manifest. This file is a site convention for assistants. It is not a formal standard. It is built from the same public pages and tool registrations as sitemap.xml and llms.txt. readOnlyHint true means the tool does not change the page. changesPage true means the tool can change the example color only.",
    pages,
  };
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
    "A JSON manifest of these pages and tools is at " + mdLink("/.well-known/webmcp", absoluteUrl("/.well-known/webmcp")) + ". It is built from the same list as this file. It is a discovery aid, not a formal standard.",
    "",
    "Every public page has a search form named find_site_page. It finds a page from this list. The widget home page also has a color form named set_color_form. If an assistant submits that color form, the page asks a person to confirm before the color changes. A direct set_color or reset_color tool call still applies at once.",
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
