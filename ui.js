(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const { normalize, parseDomain, resolve } = AutoSpace;
  let settings = normalize(), saved = "", ruleId = 0, url = null;
  const status = text => { $("#status").textContent = text; };
  const read = async () => normalize((await chrome.storage.local.get("settings")).settings);
  const write = async value => {
    await chrome.storage.local.set({ settings: value }); settings = value;
    if (typeof chrome.runtime.sendMessage === "function") {
      const result = await chrome.runtime.sendMessage({ type: "auto-space-registration-sync" });
      if (result?.error) throw new Error(result.error);
    }
  };
  $("#unsupported").hidden = CSS.supports("text-autospace", "normal");

  function addRule(rule = { domain: "", mode: "inherit" }, focus = false) {
    const row = $("#rule-template").content.firstElementChild.cloneNode(true);
    row.querySelector(".domain").value = rule.domain;
    row.querySelectorAll('input[type="radio"]').forEach(input => {
      input.name = "rule-" + ruleId;
      input.checked = input.value === rule.mode;
    });
    ruleId++;
    row.querySelector(".delete").addEventListener("click", () => {
      const next = row.nextElementSibling || row.previousElementSibling;
      row.remove(); $("#empty").hidden = !!$("#rules").children.length;
      (next?.querySelector(".domain") || $("#add-rule")).focus(); dirty();
    });
    $("#rules").appendChild(row); $("#empty").hidden = true;
    if (focus) row.querySelector(".domain").focus();
  }
  function formSettings() {
    return { enabled: $("#enabled").checked, siteRules: [...document.querySelectorAll(".rule")].map(row => ({
      domain: row.querySelector(".domain").value.trim(), mode: row.querySelector('input[type="radio"]:checked').value
    })) };
  }
  function dirty() {
    status(JSON.stringify(formSettings()) === saved ? "已保存" : "有未保存的更改");
  }
  async function options() {
    $("#enabled").checked = settings.enabled;
    settings.siteRules.forEach(rule => addRule(rule)); saved = JSON.stringify(formSettings());
    $("#empty").hidden = !!settings.siteRules.length;
    $("#add-rule").addEventListener("click", () => { addRule(undefined, true); dirty(); });
    $("#settings-form").addEventListener("input", event => { if (event.target.matches(".domain")) event.target.setCustomValidity(""); dirty(); });
    $("#settings-form").addEventListener("change", dirty);
    $("#settings-form").addEventListener("submit", async event => {
      event.preventDefault();
      const value = formSettings(), seen = new Set();
      const draft = JSON.stringify(value);
      for (const [i, rule] of value.siteRules.entries()) {
        const parsed = parseDomain(rule.domain), input = document.querySelectorAll(".domain")[i];
        input.setCustomValidity(!parsed ? "请填写有效域名，例如 example.com。" : seen.has(parsed.domain) ? "此域名已有规则。" : "");
        if (!input.reportValidity()) return;
        rule.domain = parsed.domain; seen.add(rule.domain);
      }
      $("#save").disabled = true;
      try {
        await write(value);
        if (JSON.stringify(formSettings()) === draft) {
          document.querySelectorAll(".domain").forEach((input, i) => { input.value = value.siteRules[i].domain; });
        }
        saved = JSON.stringify(value);
        status(JSON.stringify(formSettings()) === saved ? "已保存，已打开的网页会自动应用。" : "已保存，仍有未保存的更改。");
      } catch { status("保存失败，请重试。"); }
      finally { $("#save").disabled = false; }
    });
  }
  function renderPopup() {
    $("#enabled").checked = settings.enabled;
    if (!url) return;
    const result = resolve(settings, url.href);
    document.querySelectorAll('[name="site-mode"]').forEach(input => { input.checked = input.value === (result.rule?.mode || "inherit"); });
    $("#effective").textContent = "当前：" + (result.enabled ? "开启" : "关闭") + (result.rule ? " · 匹配 " + result.rule.domain : " · 跟随全局");
  }
  async function savePopup(value) {
    $("#enabled").disabled = true;
    $("#site-mode").disabled = true;
    try { await write(value); status("已保存"); } catch { status("保存失败，请重试。"); }
    finally {
      $("#enabled").disabled = false;
      $("#site-mode").disabled = !url?.hostname;
      renderPopup();
    }
  }
  async function popup() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try { const candidate = new URL(tab?.url); if (["http:", "https:", "file:"].includes(candidate.protocol)) url = candidate; } catch {}
    $("#host").textContent = url?.hostname || (url?.protocol === "file:" ? "本地文件" : "此页面不支持扩展注入");
    $("#site-mode").disabled = !url?.hostname;
    renderPopup();
    $("#enabled").addEventListener("change", async () => {
      await savePopup({ ...settings, enabled: $("#enabled").checked });
    });
    $("#site-mode").addEventListener("change", async event => {
      const domain = parseDomain(url.host).domain, mode = event.target.value;
      const rules = settings.siteRules.filter(rule => rule.domain !== domain);
      rules.push({ domain, mode });
      await savePopup({ ...settings, siteRules: rules });
    });
    $("#open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  }
  read().then(value => { settings = value; return document.body.dataset.view === "popup" ? popup() : options(); }).catch(() => status("读取设置失败，请重新打开此页面。"));
})();
