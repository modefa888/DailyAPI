(() => {
  const TOKEN_KEY = "userToken";
  const LOGIN_PATH = "/login/index.html";
  const IGNORE_PATHS = new Set(["/index.html", "/404.html", LOGIN_PATH]);

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
  if (!token) {
    const params = new URLSearchParams(window.location.search);
    const from = currentPath === "/no-access.html" ? params.get("from") : "";
    const redirect = encodeURIComponent(
      (from && String(from).startsWith("/")) ? from : (window.location.pathname + window.location.search + window.location.hash)
    );
    window.location.href = `${LOGIN_PATH}?redirect=${redirect}`;
    return;
  }

  fetch("/user/profile", { headers: { Authorization: "Bearer " + token } })
    .then((res) => res.json())
    .then((data) => {
      if (data.code !== 200) {
        const params = new URLSearchParams(window.location.search);
        const from = currentPath === "/no-access.html" ? params.get("from") : "";
        const redirect = encodeURIComponent(
          (from && String(from).startsWith("/")) ? from : (window.location.pathname + window.location.search + window.location.hash)
        );
        window.location.href = `${LOGIN_PATH}?redirect=${redirect}`;
      }
    })
    .catch(() => {
      const params = new URLSearchParams(window.location.search);
      const from = currentPath === "/no-access.html" ? params.get("from") : "";
      const redirect = encodeURIComponent(
        (from && String(from).startsWith("/")) ? from : (window.location.pathname + window.location.search + window.location.hash)
      );
      window.location.href = `${LOGIN_PATH}?redirect=${redirect}`;
    });
})();
