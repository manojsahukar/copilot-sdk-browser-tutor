// Sign-in allow list (ALLOWED_LOGINS). Entries are comma-separated GitHub logins, matched without case.
// An entry that starts with "*" is a suffix rule: "*_seemu" allows any login that ends with "_seemu"
// and has at least one character before it. A bare "*", or a "*" anywhere else, is ignored with a warning,
// so a typo can never open the app to everyone.
export function parseAllowList(raw, warn = (m) => console.warn(m)) {
  const exact = new Set(), suffixes = [];
  const entries = String(raw || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const e of entries) {
    const star = e.indexOf("*");
    if (star === -1) { exact.add(e); continue; }
    const suf = e.slice(1);
    if (star !== 0 || !suf || suf.includes("*")) { warn(`ALLOWED_LOGINS: ignoring unsafe pattern "${e}" (only "*suffix" is supported)`); continue; }
    suffixes.push(suf);
  }
  // "enforced" is true whenever anything was set, even if every entry was ignored: then nobody gets in.
  return { exact, suffixes, size: exact.size + suffixes.length, enforced: entries.length > 0 };
}
export function isLoginAllowed(list, login) {
  const l = String(login || "").toLowerCase();
  if (!l) return false;
  return list.exact.has(l) || list.suffixes.some((s) => l.length > s.length && l.endsWith(s));
}
