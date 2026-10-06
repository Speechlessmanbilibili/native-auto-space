importScripts("shared.js");

let settings = null, revision = 0;
const ready = chrome.storage.local.get("settings").then(stored => {
  if (!settings) settings = AutoSpace.normalize(stored.settings);
});
const pending = new Map(), applied = new Map();
let registrationWork = Promise.resolve();
function registrationShape(script) {
  return JSON.stringify([script.id, script.css, script.matches, script.excludeMatches || [], script.allFrames,
    script.matchOriginAsFallback, script.runAt, script.persistAcrossSessions]);
}
function syncRegistration() {
  registrationWork = registrationWork.catch(() => {}).then(async () => {
    await ready;
    const wanted = AutoSpace.earlyScripts(settings);
    const current = (await chrome.scripting.getRegisteredContentScripts()).filter(script => script.id.startsWith("auto-space-early-"));
    const byId = new Map(current.map(script => [script.id, script]));
    const wantedIds = new Set(wanted.map(script => script.id));
    const remove = current.filter(script => !wantedIds.has(script.id)).map(script => script.id);
    if (remove.length) await chrome.scripting.unregisterContentScripts({ ids: remove });
    const update = wanted.filter(script => byId.has(script.id) && registrationShape(script) !== registrationShape(byId.get(script.id)));
    if (update.length) await chrome.scripting.updateContentScripts(update);
    const add = wanted.filter(script => !byId.has(script.id));
    if (add.length) await chrome.scripting.registerContentScripts(add);
  });
  return registrationWork;
}
syncRegistration().catch(error => console.error("提前样式注册失败：", error.message));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  settings = AutoSpace.normalize(changes.settings.newValue); revision++;
  syncRegistration().catch(error => console.error("提前样式注册失败：", error.message));
});
chrome.tabs.onRemoved.addListener(tabId => {
  for (const [key, state] of applied) if (state.tabId === tabId) applied.delete(key);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "auto-space-registration-sync") {
    syncRegistration().then(() => respond({ ok: true }), error => respond({ error: error.message }));
    return true;
  }
  if (message?.type !== "auto-space-apply" || !sender.tab || !sender.documentId) return;
  const key = sender.documentId;
  const task = (pending.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    await ready;
    const address = AutoSpace.sourceAddress(sender.url, sender.origin, message.sourceAddress);
    // 后台异步补充 USER 重要声明，覆盖网页样式表及行内的重要声明。
    const options = { target: { tabId: sender.tab.id, documentIds: [key] }, css: AutoSpace.CSS, origin: "USER" };
    let state, version;
    do {
      version = revision;
      state = AutoSpace.resolve(settings, address);
      // 页面只报告已完成且没有后续未确认操作的样式状态；后台休眠后可复用旧注入顺序。
      const previous = applied.get(key) || (typeof message.userStyle === "boolean" ? { enabled: message.userStyle } : null);
      // 首次添加直接注入；相同配置复用样式，后台重启后的关闭请求仍清理旧样式。
      if (state.enabled) {
        if (!previous?.enabled) {
          // 后台重启会丢失内存状态，但旧文档的 USER 样式仍在。先移除旧副本，
          // 保持单份注入，使关闭操作完整恢复网站原有间距。
          if (!previous && message.initial !== true) await chrome.scripting.removeCSS(options);
          await chrome.scripting.insertCSS(options);
        }
      } else if (previous?.enabled || (!previous && message.initial !== true)) await chrome.scripting.removeCSS(options);
      applied.set(key, { enabled: state.enabled, tabId: sender.tab.id });
      if (applied.size > 1024) applied.delete(applied.keys().next().value);
    } while (version !== revision);
    return { enabled: state.enabled };
  });
  pending.set(key, task);
  task.then(respond, () => respond(null)).finally(() => { if (pending.get(key) === task) pending.delete(key); });
  return true;
});
