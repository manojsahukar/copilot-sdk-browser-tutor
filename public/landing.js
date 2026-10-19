fetch("/api/config").then(r => r.json()).then(c => {
  if (c.devBypass) {
    document.getElementById("dev").hidden = false;
    document.getElementById("devLogin").onclick = async () => { await fetch("/auth/dev", { method: "POST" }); location.href = "/"; };
  }
});
