/* 页面通知后台补充 USER 样式；根元素开关同时控制已注册的首屏 CSS。 */
(() => {
  "use strict";
  let initial = true, request = 0, disabled = false, rootObserver = null, userStyle = null;
  function setEarly(enabled) {
    disabled = !enabled;
    if (document.documentElement) {
      document.documentElement.toggleAttribute("data-native-auto-space-off", disabled);
      rootObserver?.disconnect(); rootObserver = null;
    } else if (!rootObserver) {
      rootObserver = new MutationObserver(() => { if (document.documentElement) setEarly(!disabled); });
      rootObserver.observe(document, { childList: true });
    }
  }
  function address() {
    return /^about:(?:blank|srcdoc)/.test(location.href) ? document.referrer || location.ancestorOrigins?.[0] || location.href : location.href;
  }
  function apply() {
    const current = ++request;
    const first = initial; initial = false;
    const confirmedStyle = userStyle; userStyle = null;
    chrome.runtime.sendMessage({ type: "auto-space-apply", initial: first, userStyle: confirmedStyle }).then(state => {
      if (current === request && state) { userStyle = state.enabled; setEarly(state.enabled); }
    }).catch(() => {});
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    setEarly(AutoSpace.resolve(AutoSpace.normalize(changes.settings.newValue), address()).enabled);
    apply();
  });
  apply();
})();
