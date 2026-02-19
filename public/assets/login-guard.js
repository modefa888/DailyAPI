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
      const HEARTBEAT_INTERVAL = 60 * 1000;
      let heartbeatTimer = null;
      const sendHeartbeat = () => {
        const activeToken = localStorage.getItem(TOKEN_KEY) || "";
        if (!activeToken) return;
        const page = window.location.pathname + window.location.search + window.location.hash;
        fetch("/user/heartbeat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + activeToken,
          },
          body: JSON.stringify({ page }),
        }).catch(() => {});
      };
      const startHeartbeat = () => {
        if (heartbeatTimer) return;
        sendHeartbeat();
        heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) sendHeartbeat();
        });
      };
      startHeartbeat();
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
