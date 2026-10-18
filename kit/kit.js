/* 案头设计系统 · 界面工具
   三款扩展共用；只处理表现层，不读写扩展配置。 */
(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

  function debounce(fn, wait = 120) {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function platformShortcut() {
    return isMac ? "⌘S" : "Ctrl+S";
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return bytes + " 字节";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  // 原生 details 的高度过渡：保留键盘语义，只在指针点击时接管动画。
  function animateDetails(details) {
    if (!details || details.dataset.kitDetails === "1") return;
    details.dataset.kitDetails = "1";
    const summary = details.querySelector("summary");
    const content = details.querySelector(":scope > :not(summary)");
    if (!summary || !content) return;
    let expanded = details.open;
    let heightAnimation = null;
    let contentAnimation = null;
    const finish = () => {
      heightAnimation?.cancel();
      contentAnimation?.cancel();
      heightAnimation = contentAnimation = null;
      details.open = expanded;
      details.style.removeProperty("height");
      details.style.removeProperty("overflow");
      content.style.removeProperty("opacity");
    };
    summary.addEventListener("click", event => {
      if (event.target.closest("button, a, input, label")) return;
      event.preventDefault();
      const startHeight = details.getBoundingClientRect().height;
      const startOpacity = details.open ? Number(getComputedStyle(content).opacity) : 0;
      expanded = !expanded;
      if (reducedMotion.matches) { finish(); return; }
      heightAnimation?.cancel();
      contentAnimation?.cancel();
      details.open = true;
      details.style.height = "auto";
      const endHeight = expanded ? details.getBoundingClientRect().height
        : summary.getBoundingClientRect().height;
      details.style.height = startHeight + "px";
      details.style.overflow = "hidden";
      const timing = { duration: expanded ? 220 : 170, easing: "cubic-bezier(.2,.8,.2,1)" };
      heightAnimation = details.animate([{ height: startHeight + "px" }, { height: endHeight + "px" }], timing);
      contentAnimation = content.animate([{ opacity: startOpacity }, { opacity: expanded ? 1 : 0 }], timing);
      heightAnimation.onfinish = finish;
    });
    window.addEventListener("resize", finish);
    reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) finish(); });
  }

  function initDetails(root = document) {
    $$("details.rule-secondary, details.details-section, details.site-rules-help, details.font-library, details[data-animate]", root)
      .forEach(animateDetails);
  }

  // 目录随滚动高亮；不改变滚动行为，点击仍用原生锚点。
  function initRailSpy() {
    const links = $$(".rail a[href^='#']");
    if (!links.length || !("IntersectionObserver" in window)) return;
    const sections = links.map(link => document.getElementById(link.getAttribute("href").slice(1))).filter(Boolean);
    const visible = new Map();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
      let best = null;
      let bestRatio = 0;
      for (const [id, ratio] of visible) if (ratio > bestRatio) { best = id; bestRatio = ratio; }
      if (!best) return;
      for (const link of links) {
        if (link.getAttribute("href") === "#" + best) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      }
    }, { rootMargin: "-72px 0px -55% 0px", threshold: [0, .2, .5, 1] });
    sections.forEach(section => observer.observe(section));
  }

  // 标签页：方向键切换，aria-selected 与 hidden 面板同步。
  function initTabs(root, onChange) {
    if (!root) return;
    const tabs = $$('[role="tab"]', root);
    const panels = tabs.map(tab => document.getElementById(tab.getAttribute("aria-controls"))).filter(Boolean);
    function select(index, focus = false) {
      tabs.forEach((tab, i) => {
        const active = i === index;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        if (panels[i]) panels[i].hidden = !active;
      });
      if (focus) tabs[index].focus();
      onChange?.(tabs[index]);
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => select(index));
      tab.addEventListener("keydown", event => {
        const key = event.key;
        let next = null;
        if (key === "ArrowRight" || key === "ArrowDown") next = (index + 1) % tabs.length;
        else if (key === "ArrowLeft" || key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
        else if (key === "Home") next = 0;
        else if (key === "End") next = tabs.length - 1;
        if (next === null) return;
        event.preventDefault();
        select(next, true);
      });
    });
    select(Math.max(0, tabs.findIndex(tab => tab.getAttribute("aria-selected") === "true")));
  }

  function toast(message, options = {}) {
    let region = $(".toast-region");
    if (!region) {
      region = document.createElement("div");
      region.className = "toast-region";
      region.setAttribute("aria-live", "polite");
      document.body.appendChild(region);
    }
    const item = document.createElement("div");
    item.className = "toast";
    item.setAttribute("role", options.role || "status");
    const text = document.createElement("span");
    text.textContent = message;
    item.appendChild(text);
    if (options.actionLabel && typeof options.onAction === "function") {
      const action = document.createElement("button");
      action.type = "button";
      action.textContent = options.actionLabel;
      action.addEventListener("click", () => { options.onAction(); item.remove(); });
      item.appendChild(action);
    }
    region.appendChild(item);
    const timeout = options.timeout ?? 4200;
    if (timeout > 0) {
      const timer = setTimeout(() => item.remove(), timeout);
      item.addEventListener("mouseenter", () => clearTimeout(timer), { once: true });
    }
    return item;
  }

  function setBusy(element, busy) {
    if (!element) return;
    element.setAttribute("aria-busy", String(Boolean(busy)));
    if ("disabled" in element) element.disabled = Boolean(busy);
  }

  window.DSH = { $, $$, debounce, platformShortcut, formatBytes, animateDetails, initDetails, initRailSpy, initTabs, toast, setBusy, reducedMotion, isMac };
})();
