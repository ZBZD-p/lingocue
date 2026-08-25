const DEFAULT_BACKEND = "http://127.0.0.1:8420";

const baseInput = document.getElementById("base");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

function setStatus(text, isError) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", !!isError);
}

function normalizeBase(text) {
  const trimmed = text.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(trimmed)) return null;
  return trimmed;
}

(async function restore() {
  const stored = await chrome.storage.local.get("backendBase");
  baseInput.value = stored.backendBase || DEFAULT_BACKEND;
})();

saveBtn.addEventListener("click", async () => {
  const base = normalizeBase(baseInput.value);
  if (!base) {
    setStatus("地址格式不对，要类似 http://127.0.0.1:8420 这样", true);
    return;
  }

  // The two localhost/127.0.0.1 forms are already covered by the manifest's
  // static host_permissions; anything else (a LAN IP) needs the user to
  // grant it here, since manifest permissions can't be edited at runtime.
  const isDefaultHost = /^https?:\/\/(127\.0\.0\.1|localhost):8420$/.test(base);
  if (!isDefaultHost) {
    const granted = await chrome.permissions.request({ origins: [`${base}/*`] });
    if (!granted) {
      setStatus("没有拿到访问这个地址的权限，保存已取消", true);
      return;
    }
  }

  await chrome.storage.local.set({ backendBase: base });
  setStatus("已保存，刷新一下 YouTube 页面就会生效");
});
