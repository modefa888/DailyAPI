(() => {
  const NO_ACCESS_PATH = "/no-access.html";
  const IGNORE_PATHS = new Set(["/404.html", NO_ACCESS_PATH]);
  const TOKEN_KEY = "userToken";

  const normalizePath = (pathname) => {
    let p = decodeURIComponent(String(pathname || ""));
    if (!p.startsWith("/")) p = "/" + p;
    if (p.endsWith("/")) return p + "index.html";
    if (!p.endsWith(".html")) return p + "/index.html";
    return p;
  };

  const currentPath = normalizePath(window.location.pathname);
  if (IGNORE_PATHS.has(currentPath)) return;

  const token = localStorage.getItem(TOKEN_KEY) || "";
  if (!token) return;

  fetch("/user/profile", {
    headers: { Authorization: "Bearer " + token },
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.code !== 200 || !data.data) return;
      if (data.data.role === "admin") return;
      if (data.data.pagesLimited !== true) return;
      const blocked = Array.isArray(data.data.blockedPages) ? data.data.blockedPages : [];
      if (blocked.includes(currentPath)) {
        const from = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
        window.location.href = `${NO_ACCESS_PATH}?from=${from}`;
      }
    })
    .catch(() => {});
})();
