/* 共享设置与站点匹配。只处理配置，不读取页面文字或字体。 */
(() => {
  "use strict";
  const CSS = "*, ::before, ::after, ::placeholder { text-autospace: normal !important; }";
  const MODES = ["inherit", "on", "off"];
  function parseDomain(value) {
    const text = String(value ?? "").trim();
    if (!text || /\s/.test(text)) return null;
    const scheme = text.match(/^([a-z][a-z\d+.-]*):\/\//i);
    if (scheme && !/^https?$/i.test(scheme[1])) return null;
    const authority = text.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].replace(/^\*\./, "");
    if (!authority || authority.includes("@")) return null;
    const parts = authority.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!parts) return null;
    try {
      const host = new URL("http://" + authority).hostname.toLowerCase().replace(/\.$/, "");
      if (!host) return null;
      // 显式端口单独保留，避免 URL 把 80 等默认端口省略。
      const port = parts[2] === undefined ? null : String(Number(parts[2]));
      return { host, port, domain: host + (port === null ? "" : ":" + port) };
    } catch { return null; }
  }
  function normalize(value = {}) {
    if (!value || typeof value !== "object") value = {};
    return { enabled: value.enabled !== false, siteRules: Array.isArray(value.siteRules) ? value.siteRules
      .filter(rule => parseDomain(rule?.domain) && MODES.includes(rule.mode))
      .map(rule => ({ domain: parseDomain(rule.domain).domain, mode: rule.mode })) : [] };
  }
  function resolve(settings, address) {
    let url;
    try { url = new URL(address); } catch { return { enabled: settings.enabled, rule: null }; }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
    let rule = null, score = -1;
    for (const candidate of settings.siteRules) {
      const domain = parseDomain(candidate.domain);
      if (!domain || !(host === domain.host || host.endsWith("." + domain.host))) continue;
      if (domain.port !== null && domain.port !== port) continue;
      const rank = domain.host.length * 2 + (domain.port === null ? 0 : 1);
      if (rank > score) { score = rank; rule = candidate; }
    }
    return { enabled: rule?.mode === "on" ? true : rule?.mode === "off" ? false : settings.enabled, rule };
  }
  // 每条规则生成独立的开启区域，排除更具体规则，保持端口与顺序优先级。
  function earlyScripts(value) {
    const settings = normalize(value), seen = new Set();
    const rules = settings.siteRules.map((rule, order) => {
      const domain = parseDomain(rule.domain);
      return { ...domain, order, enabled: rule.mode === "inherit" ? settings.enabled : rule.mode === "on", rank: domain.host.length * 2 + Number(domain.port !== null) };
    }).filter(rule => { const key = rule.host + ":" + rule.port; if (seen.has(key)) return false; seen.add(key); return true; });
    const patterns = rule => {
      const host = rule.host.startsWith("[") || /^[\d.]+$/.test(rule.host) ? rule.host : "*." + rule.host;
      return ["http", "https"].map(scheme => scheme + "://" + host + (rule.port === null ? "" : ":" + rule.port) + "/*");
    };
    const script = (id, matches, excludeMatches) => ({ id: "auto-space-early-" + id, css: ["early.css"], matches,
      excludeMatches: [...new Set(excludeMatches)], allFrames: true, matchOriginAsFallback: true, runAt: "document_start", persistAcrossSessions: true });
    const result = settings.enabled ? [script("global", ["<all_urls>"], rules.flatMap(patterns))] : [];
    for (const rule of rules) if (rule.enabled) {
      const higher = rules.filter(other => (other.rank > rule.rank || (other.rank === rule.rank && other.order < rule.order))
        && (other.host === rule.host || other.host.endsWith("." + rule.host))
        && (rule.port === null || other.port === null || rule.port === other.port));
      result.push(script("rule-" + rule.order, patterns(rule), higher.flatMap(patterns)));
    }
    return result;
  }
  globalThis.AutoSpace = { CSS, MODES, parseDomain, normalize, resolve, earlyScripts };
})();
