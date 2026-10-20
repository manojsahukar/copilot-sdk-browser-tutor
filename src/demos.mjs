// Curated demo library. The model can only pick a name from this enum; it never supplies code.
// Each entry is metadata (what runs, what a site learns, how to revoke). Live demos run as STATIC client code
// in /static/demos.js; only metadata ever comes back to the tutor via run_demo.
export const DEMO_IDS = ["storage_inspector", "xss_lab", "camera", "microphone", "geolocation", "cookie_jar", "cross_site_fetch"];
export const DEMOS = {
  storage_inspector: {
    id: "storage_inspector", title: "What this site stores in YOUR browser", needsPermission: false,
    what: "Reads this origin's own client-side storage and shows it side by side: localStorage (incl. this app's saved chat history \u2014 key name, byte size, message count, saved/expiry timestamps and a short preview), sessionStorage, IndexedDB databases, and the cookies JavaScript can see (masked). It also calls navigator.storage.estimate() and persisted() for your quota, usage and whether storage is durable.",
    siteLearns: "Nothing new about you \u2014 this inspects what is ALREADY on your device. The lesson is WHERE your chat lives: your transcript is kept in this origin's localStorage (so it survives reloads and is replayed to the tutor on a cold server), readable by any JavaScript on this origin and by browser extensions. The session cookie (bt_sess) is HttpOnly, so it is deliberately ABSENT from the JS-visible cookie list.",
    localOnly: "Everything is read and shown in your own browser. Only METADATA goes to the tutor \u2014 key names, byte sizes, item/message counts, and your storage quota/usage. Never the stored content or previews.",
    teaches: "cookies (sent to the server on EVERY request; can be HttpOnly/Secure/SameSite/Domain-scoped) vs localStorage (stays in the browser, never sent automatically, readable by any same-origin JS \u2014 so one XSS or a browser extension exposes it) vs sessionStorage (per-tab, gone when the tab closes) vs IndexedDB (larger structured store). Same-origin scope: sibling.demo.curiosta.com CANNOT read copilot-sdk.demo.curiosta.com's localStorage even though it DOES receive the parent-domain cookie \u2014 cookies are Domain-scoped, Web Storage is strictly origin-scoped. Persistence/eviction: storage quotas, Safari ITP caps script-writable storage at ~7 days, and incognito clears on close. Relates to SDK gotcha #1 (an XSS on this origin would expose all of this).",
    revoke: "Inspect it yourself: DevTools \u2192 Application \u2192 Local Storage / Session Storage / IndexedDB / Cookies (Chrome & Firefox), or Safari Web Inspector \u2192 Storage; for Android Chrome use remote debugging (chrome://inspect on a desktop). Clear it: use this demo's 'Clear this site\u2019s stored data' button, Sign out, your browser's Site settings \u2192 Clear data, or clearing browsing data for this site.",
  },
  xss_lab: {
    id: "xss_lab", title: "Script injection lab (contained XSS)", needsPermission: false,
    what: "A deliberately vulnerable mini-site, embedded in an iframe, that lets you fire harmless cross-site-scripting (XSS) payloads and watch them execute \u2014 then see the same payloads neutralised by the safe pattern. Covers reflected, stored and DOM-based XSS, what injected script can do (read the JS-visible cookie, read localStorage, draw a fake login, log keystrokes, 'exfiltrate'), defences (strict CSP with securitypolicyviolation events, HttpOnly, DOMPurify, Trusted Types), and prompt-injection-to-XSS through the app's real marked+DOMPurify pipeline.",
    siteLearns: "Nothing about you \u2014 every value is dummy. The lesson is how an XSS bug turns 'just text' into attacker code running in a page's origin, and why each defence stops it.",
    localOnly: "The lab runs on its OWN throwaway origin (never the main site), is only usable when framed by the tutor, ignores anything in the URL (no shareable attack links), sets only labelled host-only dummy cookies, and can only 'exfiltrate' to its own echo endpoint. The tutor receives metadata only: which payload ran, whether it executed or was blocked, and which defence stopped it.",
    teaches: "Isolation is the whole point: a vulnerable page must live on a dedicated origin with its own headers, the main session cookie must be host-only so it never reaches the lab, payloads must never come from the URL, the lab must only run when framed by the trusted app, and 'exfiltration' must be boxed in. Compare the vulnerable innerHTML/javascript: sinks with textContent, scheme validation, strict CSP, HttpOnly and DOMPurify.",
    revoke: "This is a lab, not a permission. In the real world: escape/encode output (textContent), sanitise HTML (DOMPurify), set a strict Content-Security-Policy (script-src 'self', no inline), mark session cookies HttpOnly + Secure + SameSite, validate URL schemes, and consider Trusted Types.",
  },
  camera: {
    id: "camera", title: "Camera access", needsPermission: true,
    what: "Calls navigator.mediaDevices.getUserMedia({video:true}). The browser shows a permission prompt; if you allow, the page gets a live video stream.",
    siteLearns: "That a camera exists and works, its capabilities (resolution, frame rate, facing mode) and a per-origin device id. With the stream a site could capture stills or video. Labels (e.g. 'FaceTime HD Camera') become readable only after you grant access.",
    localOnly: "The stream is shown back to you in the page and never leaves your device: no frame is uploaded, and only metadata (track count, resolution, frame rate) is reported to the tutor.",
    revoke: "Click the camera icon in the address bar → Block, or Site settings → Camera → Block. On iOS Safari: aA menu → Website Settings → Camera. Reset site permissions to be re-asked.",
  },
  microphone: {
    id: "microphone", title: "Microphone access", needsPermission: true,
    what: "Calls getUserMedia({audio:true}) and runs a Web Audio analyser on the local stream to show a live input level.",
    siteLearns: "That a microphone exists, its settings (sample rate, channel count, echo-cancellation), a device id, and — if granted — the audio itself.",
    localOnly: "Audio is analysed in the page for a level meter only; nothing is recorded or uploaded. Only metadata (sample rate, channels) goes to the tutor.",
    revoke: "Address-bar microphone icon → Block, or Site settings → Microphone. Reset permissions to be prompted again.",
  },
  geolocation: {
    id: "geolocation", title: "Precise location", needsPermission: true,
    what: "Calls navigator.geolocation.getCurrentPosition(). The browser prompts; if allowed it returns GPS/Wi-Fi-derived latitude and longitude with an accuracy radius.",
    siteLearns: "Your location, often to a few metres — far more precise than IP geolocation. Combined with an id it can track movements over time.",
    localOnly: "Your precise coordinates are shown only to you. The tutor receives coarse location rounded to ~0.1° (about 11 km) plus the accuracy figure, never the exact point.",
    revoke: "Address-bar location icon → Block, or Site settings → Location. Browsers also offer a global 'ask every time'. A VPN does NOT hide this (it's device GPS/Wi-Fi, not IP).",
  },
  cookie_jar: {
    id: "cookie_jar", title: "Cross-site cookies", needsPermission: false,
    what: "The sibling origin sets a dummy cookie scoped to Domain=demo.curiosta.com (SameSite=None; Secure), then a 'what the sibling saw' view shows the same id arriving on a later request.",
    siteLearns: "How a third-party domain can plant an identifier that is sent back on future requests, the basis of cross-site tracking. Here the id is random and meaningless.",
    localOnly: "The cookie is a random dummy id, not tied to you; its value is masked when shown. No real identifier is used.",
    revoke: "Block third-party cookies (the default in many browsers now): Settings → Privacy. Clear cookies for the site, or use the demo's 'Clear demo cookie' button.",
  },
  cross_site_fetch: {
    id: "cross_site_fetch", title: "Cross-site requests (CORS vs no-CORS)", needsPermission: false,
    what: "From this page, fetches two endpoints on the sibling origin: one that returns CORS headers (the response is readable) and one that does not (the response is opaque). Then it loads the sibling's 'what I saw' view.",
    siteLearns: "That any page can SEND a request to another origin carrying your cookies; CORS only controls whether the page can READ the reply. Even an unreadable (no-CORS) request still reaches the other server, which sees your IP, User-Agent and any cross-site cookie.",
    localOnly: "Requests go only to this demo's sibling host; no third party is contacted. Only counts and the sibling's masked view are reported to the tutor.",
    revoke: "This is normal web behaviour, not a permission. Defenses: block third-party cookies, use tracker-blocking extensions, and note that a site's own Content-Security-Policy connect-src limits where ITS page may send requests (this app allowlists only its sibling).",
  },
};
