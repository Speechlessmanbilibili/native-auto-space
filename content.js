/* 页面仅通知后台应用配置；不监听 DOM、输入或指针事件。 */
(() => {
  "use strict";
  const apply = () => chrome.runtime.sendMessage({ type: "auto-space-apply" }).catch(() => {});
  apply();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) apply();
  });
})();
