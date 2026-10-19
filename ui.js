(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const { normalize, parseDomain, resolve } = AutoSpace;
  let settings = normalize(), saved = "", ruleId = 0, url = null, saving = false;
  const status = (text, state = "neutral") => {
    $("#status").textContent = text;
    $("#status").dataset.state = state;
  };
  const read = async () => normalize((await chrome.storage.local.get("settings")).settings);
  const write = async value => {
    await chrome.storage.local.set({ settings: value }); settings = value;
    if (typeof chrome.runtime.sendMessage === "function") {
      const result = await chrome.runtime.sendMessage({ type: "auto-space-registration-sync" });
      if (result?.error) throw new Error(result.error);
    }
  };
  $("#unsupported").hidden = CSS.supports("text-autospace", "normal");

  // 预览直接反映开关草稿，保存操作独立处理实际网页配置。
  function updateGlobalUI() {
    const enabled = $("#enabled").checked;
    $("#global-state").textContent = enabled ? "已开启" : "已关闭";
    if ($("#preview-panel")) {
      $("#preview-panel").dataset.enabled = String(enabled);
      $("#preview-label").textContent = enabled ? "当前设置 · 已开启" : "当前设置 · 已关闭";
    }
  }
  function updateRuleCount() {
    const count = $("#rules").children.length;
    $("#rule-count").textContent = count;
    $("#rule-count").setAttribute("aria-label", "已设置 " + count + " 条网站规则");
    $("#empty").hidden = count > 0;
  }
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
      row.remove();
      (next?.querySelector(".domain") || $("#add-rule")).focus(); dirty();
    });
    $("#rules").appendChild(row); updateRuleCount();
    if (focus) { row.classList.add("is-new"); row.querySelector(".domain").focus(); }
  }
  function formSettings() {
    return { enabled: $("#enabled").checked, siteRules: [...document.querySelectorAll(".rule")].map(row => ({
      domain: row.querySelector(".domain").value.trim(), mode: row.querySelector('input[type="radio"]:checked').value
    })) };
  }
  function dirty() {
    updateGlobalUI(); updateRuleCount();
    const changed = JSON.stringify(formSettings()) !== saved;
    status(changed ? "有未保存的更改" : "已保存", changed ? "dirty" : "success");
  }
  async function options() {
    $("#enabled").checked = settings.enabled;
    settings.siteRules.forEach(rule => addRule(rule)); saved = JSON.stringify(formSettings());
    dirty();
    $("#add-rule").addEventListener("click", () => { addRule(undefined, true); dirty(); });
    $("#settings-form").addEventListener("input", event => { if (event.target.matches(".domain")) event.target.setCustomValidity(""); dirty(); });
    $("#settings-form").addEventListener("change", dirty);
    $("#settings-form").addEventListener("submit", async event => {
      event.preventDefault();
      if (saving) return;
      const value = formSettings(), seen = new Set();
      const draft = JSON.stringify(value);
      for (const [i, rule] of value.siteRules.entries()) {
        const parsed = parseDomain(rule.domain), input = document.querySelectorAll(".domain")[i];
        input.setCustomValidity(!parsed ? "请填写有效域名，例如example.com。" : seen.has(parsed.domain) ? "此域名已有规则。" : "");
        if (!input.reportValidity()) return;
        rule.domain = parsed.domain; seen.add(rule.domain);
      }
      saving = true; $("#save").disabled = true;
      $("#save").setAttribute("aria-busy", "true");
      status("正在保存……", "saving");
      try {
        const merged = AutoSpace.mergeDraft(JSON.parse(saved), value, await read());
        await write(merged);
        const current = formSettings();
        const rebased = AutoSpace.mergeDraft(JSON.parse(draft), current, merged);
        $("#enabled").checked = rebased.enabled;
        if (JSON.stringify(current.siteRules) !== JSON.stringify(rebased.siteRules)) {
          $("#rules").replaceChildren(); rebased.siteRules.forEach(rule => addRule(rule));
        }
        saved = JSON.stringify(merged);
        updateGlobalUI(); updateRuleCount();
        const changed = JSON.stringify(formSettings()) !== saved;
        status(changed ? "已保存，仍有未保存的更改。" : "已保存，已打开的网页会自动应用。", changed ? "dirty" : "success");
      } catch { status("保存失败，请重试。", "error"); }
      finally { saving = false; $("#save").disabled = false; $("#save").setAttribute("aria-busy", "false"); }
    });
  }
  function renderPopup() {
    $("#enabled").checked = settings.enabled;
    updateGlobalUI();
    if (!url) return;
    const result = resolve(settings, url.href);
    document.querySelectorAll('[name="site-mode"]').forEach(input => { input.checked = input.value === (result.rule?.mode || "inherit"); });
    $("#effective").textContent = "当前：" + (result.enabled ? "开启" : "关闭") + (result.rule ? " · 匹配" + result.rule.domain : " · 跟随全局");
  }
  async function savePopup(change) {
    $("#enabled").disabled = true;
    $("#site-mode").disabled = true;
    try { await write(change(await read())); status("已保存", "success"); } catch { status("保存失败，请重试。", "error"); }
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
      const enabled = $("#enabled").checked;
      updateGlobalUI();
      await savePopup(latest => ({ ...latest, enabled }));
    });
    $("#site-mode").addEventListener("change", async event => {
      const mode = event.target.value;
      await savePopup(latest => {
        const current = parseDomain(url.host), matched = parseDomain(resolve(latest, url.href).rule?.domain);
        // URL省略默认端口时，继续编辑当前主机实际命中的显式端口规则。
        const domain = matched?.host === current.host && matched.port !== null ? matched.domain : current.domain;
        const rules = latest.siteRules.filter(rule => rule.domain !== domain);
        rules.push({ domain, mode });
        return { ...latest, siteRules: rules };
      });
    });
    $("#open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  }
  read().then(value => { settings = value; return document.body.dataset.view === "popup" ? popup() : options(); }).catch(() => status("读取设置失败，请重新打开此页面。", "error"));
})();
