importScripts("shared.js");

// 同一文档的设置按顺序应用；使用文档 ID，避免导航后把旧请求写到新页面。
const pending = new Map();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "auto-space-apply" || sender.id !== chrome.runtime.id || !sender.tab || !sender.documentId) return;
  const key = sender.documentId;
  const task = (pending.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get("settings");
    const address = /^about:(?:blank|srcdoc)(?:[#?]|$)/.test(sender.url || "") ? sender.origin : sender.url;
    const state = AutoSpace.resolve(AutoSpace.normalize(stored.settings), address);
    const options = { target: { tabId: sender.tab.id, documentIds: [key] }, css: AutoSpace.CSS, origin: "USER" };
    // 使用浏览器样式注入接口，不创建页面样式节点；动态文字自动受选择器覆盖。
    await chrome.scripting.removeCSS(options);
    if (state.enabled) await chrome.scripting.insertCSS(options);
    return { enabled: state.enabled };
  });
  pending.set(key, task);
  task.then(respond, () => respond(null)).finally(() => { if (pending.get(key) === task) pending.delete(key); });
  return true;
});
