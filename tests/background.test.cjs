const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const sharedSource = fs.readFileSync(path.join(root, "shared.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");
const sharedContext = { URL };
vm.runInNewContext(sharedSource, sharedContext, { filename: "shared.js" });
const AutoSpace = sharedContext.AutoSpace;
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const enabledSettings = enabled => ({ enabled, siteRules: [] });

// 仅接受 Chrome 公开支持的注册字段，避免模拟 API 接受不存在的来源参数。
// https://developer.chrome.com/docs/extensions/reference/api/scripting#type-RegisteredContentScript
const registeredProperties = new Set([
  "id", "css", "js", "matches", "excludeMatches", "allFrames", "matchOriginAsFallback",
  "runAt", "persistAcrossSessions", "world"
]);
function validateRegistration(script) {
  for (const key of Object.keys(script)) assert.ok(registeredProperties.has(key), "不支持的注册字段：" + key);
  assert.equal(Object.hasOwn(script, "origin"), false);
  assert.equal(Object.hasOwn(script, "cssOrigin"), false);
  assert.match(script.id, /^auto-space-early-/);
  assert.deepEqual(plain(script.css), ["early.css"]);
  assert.ok(script.matches.length > 0);
  assert.equal(script.allFrames, true);
  assert.equal(script.matchOriginAsFallback, true);
  assert.equal(script.runAt, "document_start");
  assert.equal(script.persistAcrossSessions, true);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return listeners.map(listener => listener(...args)); },
    get listener() { assert.equal(listeners.length, 1); return listeners[0]; }
  };
}
function onlyKnownAPI(value, name, unexpected) {
  return new Proxy(value, {
    get(target, property) {
      if (typeof property === "string" && !Object.hasOwn(target, property)) {
        unexpected.push(name + "." + property);
        throw new Error("未授权的模拟 API：" + name + "." + property);
      }
      return Reflect.get(target, property);
    }
  });
}
function environment(initialSettings = enabledSettings(true)) {
  let stored = plain(initialSettings);
  const registrations = new Map(), sheets = new Map(), calls = [], errors = [], unexpected = [];
  const delayed = new Map();
  const wrap = (value, name) => onlyKnownAPI(value, name, unexpected);
  function pauseNext(method) {
    const entered = deferred(), released = deferred();
    const queue = delayed.get(method) || [];
    queue.push({ entered, released }); delayed.set(method, queue);
    return { entered: entered.promise, release: released.resolve };
  }
  async function record(method, value) {
    calls.push({ method, value: plain(value) });
    const pause = delayed.get(method)?.shift();
    if (pause) { pause.entered.resolve(); await pause.released.promise; }
  }
  function sheetKey(options) {
    return JSON.stringify([options.target.tabId, options.target.documentIds, options.css, options.origin]);
  }
  function validateInjection(options) {
    assert.deepEqual(Object.keys(options).sort(), ["css", "origin", "target"]);
    assert.deepEqual(Object.keys(options.target).sort(), ["documentIds", "tabId"]);
    assert.equal(options.target.documentIds.length, 1);
    assert.equal(typeof options.target.documentIds[0], "string");
    assert.equal(Number.isInteger(options.target.tabId), true);
    assert.equal(options.css, AutoSpace.CSS);
    assert.equal(options.origin, "USER");
  }
  const scripting = wrap({
    async getRegisteredContentScripts() {
      await record("getRegisteredContentScripts");
      return plain([...registrations.values()]);
    },
    async registerContentScripts(scripts) {
      scripts.forEach(validateRegistration);
      for (const script of scripts) assert.equal(registrations.has(script.id), false);
      await record("registerContentScripts", scripts);
      for (const script of scripts) registrations.set(script.id, plain(script));
    },
    async updateContentScripts(scripts) {
      scripts.forEach(validateRegistration);
      for (const script of scripts) assert.equal(registrations.has(script.id), true);
      await record("updateContentScripts", scripts);
      for (const script of scripts) registrations.set(script.id, { ...registrations.get(script.id), ...plain(script) });
    },
    async unregisterContentScripts(filter) {
      assert.deepEqual(Object.keys(filter), ["ids"]);
      await record("unregisterContentScripts", filter);
      for (const id of filter.ids) registrations.delete(id);
    },
    async insertCSS(options) {
      validateInjection(options);
      await record("insertCSS", options);
      const key = sheetKey(options);
      sheets.set(key, (sheets.get(key) || 0) + 1);
    },
    async removeCSS(options) {
      validateInjection(options);
      await record("removeCSS", options);
      // Blink 每次只移除最后一份匹配样式，不能把重复注入全部抹掉。
      // https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/core/css/style_engine.cc
      const key = sheetKey(options), count = sheets.get(key) || 0;
      if (count > 1) sheets.set(key, count - 1);
      else sheets.delete(key);
    }
  }, "chrome.scripting");
  function startWorker() {
    const onChanged = event(), onMessage = event(), onRemoved = event();
    const chrome = wrap({
      scripting,
      storage: wrap({
        local: wrap({ async get(key) { assert.equal(key, "settings"); return { settings: plain(stored) }; } }, "chrome.storage.local"),
        onChanged
      }, "chrome.storage"),
      runtime: wrap({ id: "native-auto-space-test", onMessage }, "chrome.runtime"),
      tabs: wrap({ onRemoved }, "chrome.tabs")
    }, "chrome");
    const context = vm.createContext({
      URL, chrome,
      console: { error(...args) { errors.push(args.join(" ")); } },
      importScripts(file) {
        assert.equal(file, "shared.js");
        vm.runInContext(sharedSource, context, { filename: file });
      }
    });
    vm.runInContext(backgroundSource, context, { filename: "background.js" });
    function message(value, sender = {}) {
      return new Promise((resolve, reject) => {
        try {
          const keepAlive = onMessage.listener(value, { id: chrome.runtime.id, ...sender }, reply => resolve(plain(reply)));
          if (keepAlive !== true) resolve(undefined);
        } catch (error) { reject(error); }
      });
    }
    return {
      message,
      async sync() { assert.deepEqual(await message({ type: "auto-space-registration-sync" }), { ok: true }); },
      apply({ initial = false, userStyle, ...sender } = {}) {
        return message({ type: "auto-space-apply", initial, userStyle }, {
          tab: { id: 7 }, documentId: "document-a", frameId: 0,
          url: "https://example.com/page", origin: "https://example.com", ...sender
        });
      },
      changeSettings(value, area = "local") {
        const oldValue = stored;
        if (area === "local") stored = plain(value);
        onChanged.emit({ settings: { oldValue, newValue: plain(value) } }, area);
      },
      removeTab(tabId) { onRemoved.emit(tabId); }
    };
  }
  return {
    startWorker, pauseNext, registrations, sheets, calls, errors, unexpected,
    setStored(value) { stored = plain(value); },
    cssCalls() { return calls.filter(call => ["insertCSS", "removeCSS"].includes(call.method)); },
    registrationWrites() { return calls.filter(call => /^(?:register|update|unregister)ContentScripts$/.test(call.method)); },
    assertClean() { assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); }
  };
}

test("共享配置在无浏览器环境下保留域名、端口、继承与同等规则顺序", () => {
  assert.equal(AutoSpace.normalize(null).enabled, true);
  assert.equal(AutoSpace.parseDomain("https://EXAMPLE.com:443/path").domain, "example.com:443");
  assert.equal(AutoSpace.parseDomain("[::1]:80").domain, "[::1]:80");
  for (const domain of ["", "bad domain", "https://a@b", "ftp://example.com", "example.com:65536"]) {
    assert.equal(AutoSpace.parseDomain(domain), null);
  }
  const settings = AutoSpace.normalize({ enabled: false, siteRules: [
    { domain: "example.com", mode: "on" }, { domain: "docs.example.com", mode: "off" },
    { domain: "docs.example.com:443", mode: "inherit" }, { domain: "docs.example.com:443", mode: "on" }
  ] });
  for (const [url, enabled, mode] of [
    ["https://other.example.com", true, "on"], ["https://docs.example.com", false, "inherit"],
    ["https://child.docs.example.com", false, "inherit"], ["http://docs.example.com", false, "off"],
    ["https://notexample.com", false, undefined]
  ]) {
    const result = AutoSpace.resolve(settings, url);
    assert.equal(result.enabled, enabled, url);
    assert.equal(result.rule?.mode, mode, url);
  }
});

test("提前注册仅使用公开字段，持久保持 document_start 和独立站点范围", () => {
  const scripts = plain(AutoSpace.earlyScripts({ enabled: true, siteRules: [
    { domain: "example.com", mode: "off" },
    { domain: "docs.example.com", mode: "on" },
    { domain: "docs.example.com:443", mode: "off" },
    { domain: "child.docs.example.com", mode: "inherit" },
    { domain: "docs.example.com", mode: "off" }
  ] }));
  scripts.forEach(validateRegistration);
  const patterns = host => ["http://" + host + "/*", "https://" + host + "/*"];
  assert.deepEqual(scripts.map(script => script.id), ["auto-space-early-global", "auto-space-early-rule-1", "auto-space-early-rule-3"]);
  assert.deepEqual(scripts[0].matches, ["<all_urls>"]);
  assert.deepEqual(scripts[0].excludeMatches, [
    ...patterns("*.example.com"), ...patterns("*.docs.example.com"),
    ...patterns("*.docs.example.com:443"), ...patterns("*.child.docs.example.com")
  ]);
  assert.deepEqual(scripts[1].matches, patterns("*.docs.example.com"));
  assert.deepEqual(scripts[1].excludeMatches, [...patterns("*.docs.example.com:443"), ...patterns("*.child.docs.example.com")]);
  assert.deepEqual(scripts[2].matches, patterns("*.child.docs.example.com"));
  assert.deepEqual(scripts[2].excludeMatches, []);
  assert.deepEqual(plain(AutoSpace.earlyScripts(enabledSettings(false))), []);
  assert.throws(() => validateRegistration({ ...scripts[0], origin: "USER" }), /origin/);
  assert.throws(() => validateRegistration({ ...scripts[0], cssOrigin: "user" }), /cssOrigin/);
});

test("来源回退沿用有效创建地址，blob 保留自身来源，普通网页忽略回退地址", () => {
  for (const url of ["about:blank#section", "about:srcdoc", "data:text/html,test"]) {
    assert.equal(AutoSpace.sourceAddress(url, "null", "https://example.com:8443/path"), "https://example.com:8443/path");
  }
  assert.equal(AutoSpace.sourceAddress("blob:https://example.com/id", "https://other.example.net"), "https://example.com");
  assert.equal(AutoSpace.sourceAddress("https://example.com/page", "https://other.example.net"), "https://example.com/page");
  assert.equal(AutoSpace.sourceAddress("data:text/html,test", "about:blank", "null", "https://example.com"), "https://example.com/");
});

test("非法通配域名不会进入注册范围，标准前缀通配保持正常匹配", () => {
  for (const domain of ["*", "foo*.example.com", "**.example.com", "%2a.example.com"]) assert.equal(AutoSpace.parseDomain(domain), null);
  assert.equal(AutoSpace.parseDomain("*.example.com").domain, "example.com");
  const scripts = plain(AutoSpace.earlyScripts({ enabled: true, siteRules: [{ domain: "foo*.example.com", mode: "off" }] }));
  assert.equal(scripts.length, 1); assert.deepEqual(scripts[0].excludeMatches, []);
});

test("注册同步等待完成，更新站点范围时保留其他脚本，同配置不重复注册", async () => {
  const env = environment();
  const unrelated = { id: "unrelated-script", js: ["other.js"], matches: ["https://example.com/*"] };
  env.registrations.set(unrelated.id, unrelated);
  const worker = env.startWorker();
  await worker.sync();
  assert.equal(env.registrationWrites().length, 1);
  await worker.sync();
  assert.equal(env.registrationWrites().length, 1);
  worker.changeSettings({ enabled: true, siteRules: [{ domain: "example.com", mode: "off" }] });
  await worker.sync();
  assert.equal(env.registrationWrites().at(-1).method, "updateContentScripts");
  assert.deepEqual(env.registrations.get("auto-space-early-global").excludeMatches, ["http://*.example.com/*", "https://*.example.com/*"]);
  worker.changeSettings(enabledSettings(false));
  await worker.sync();
  assert.deepEqual([...env.registrations.values()], [unrelated]);
  env.assertClean();
});

test("注册正在写入时快速保存仍同步到最终设置", { timeout: 3000 }, async () => {
  const env = environment();
  const pause = env.pauseNext("registerContentScripts");
  const worker = env.startWorker();
  await pause.entered;
  worker.changeSettings(enabledSettings(false));
  worker.changeSettings({ enabled: false, siteRules: [{ domain: "example.com", mode: "on" }] });
  worker.changeSettings(enabledSettings(false));
  const synced = worker.sync();
  pause.release();
  await synced;
  assert.equal(env.registrations.size, 0);
  env.assertClean();
});

test("USER 注入和移除使用完全一致的 CSS、来源和文档目标", async () => {
  const env = environment(), worker = env.startWorker();
  await worker.sync();
  assert.deepEqual(await worker.apply({ initial: true }), { enabled: true });
  worker.changeSettings(enabledSettings(false));
  assert.deepEqual(await worker.apply(), { enabled: false });
  const calls = env.cssCalls();
  assert.deepEqual(calls.map(call => call.method), ["insertCSS", "removeCSS"]);
  assert.deepEqual(calls[0].value, {
    target: { tabId: 7, documentIds: ["document-a"] }, css: AutoSpace.CSS, origin: "USER"
  });
  assert.deepEqual(calls[1].value, calls[0].value);
  assert.equal(env.sheets.size, 0);
  await worker.apply();
  assert.equal(env.cssCalls().length, 2);
  await worker.sync(); env.assertClean();
});

test("同一文档的并发与重复请求只注入一次，新文档各自注入", async () => {
  const env = environment(), worker = env.startWorker();
  await worker.sync();
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => worker.apply({ initial: index === 0 })));
  assert.ok(results.every(result => result.enabled));
  await worker.apply();
  assert.equal(env.cssCalls().length, 1);
  await worker.apply({ initial: true, documentId: "document-b", frameId: 0 });
  await worker.apply({ initial: true, documentId: "document-c", frameId: 4 });
  assert.deepEqual(env.cssCalls().map(call => call.value.target.documentIds), [["document-a"], ["document-b"], ["document-c"]]);
  assert.deepEqual([...env.sheets.values()], [1, 1, 1]);
  env.assertClean();
});

test("延迟注入期间快速开关与排队请求最终全部关闭", { timeout: 3000 }, async () => {
  const env = environment(), worker = env.startWorker();
  await worker.sync();
  const pause = env.pauseNext("insertCSS");
  const requests = [worker.apply({ initial: true })];
  await pause.entered;
  for (const enabled of [false, true, false]) {
    worker.changeSettings(enabledSettings(enabled));
    requests.push(worker.apply());
  }
  pause.release();
  assert.deepEqual(await Promise.all(requests), requests.map(() => ({ enabled: false })));
  assert.deepEqual(env.cssCalls().map(call => call.method), ["insertCSS", "removeCSS"]);
  assert.deepEqual(env.cssCalls()[0].value, env.cssCalls()[1].value);
  assert.equal(env.sheets.size, 0);
  await worker.sync();
  assert.equal(env.registrations.size, 0);
  env.assertClean();
});

test("延迟注入期间最终保持开启时不重复添加样式", { timeout: 3000 }, async () => {
  const env = environment(), worker = env.startWorker();
  await worker.sync();
  const pause = env.pauseNext("insertCSS");
  const first = worker.apply({ initial: true });
  await pause.entered;
  worker.changeSettings(enabledSettings(false));
  worker.changeSettings(enabledSettings(true));
  const repeated = worker.apply();
  pause.release();
  assert.deepEqual(await Promise.all([first, repeated]), [{ enabled: true }, { enabled: true }]);
  assert.deepEqual(env.cssCalls().map(call => call.method), ["insertCSS"]);
  assert.deepEqual([...env.sheets.values()], [1]);
  await worker.sync(); env.assertClean();
});

test("延迟移除期间再次开启会恢复一份样式，并返回最终状态", { timeout: 3000 }, async () => {
  const env = environment(), worker = env.startWorker();
  await worker.sync(); await worker.apply({ initial: true });
  worker.changeSettings(enabledSettings(false));
  const pause = env.pauseNext("removeCSS");
  const requests = [worker.apply()];
  await pause.entered;
  for (const enabled of [true, false, true]) {
    worker.changeSettings(enabledSettings(enabled));
    requests.push(worker.apply());
  }
  pause.release();
  assert.deepEqual(await Promise.all(requests), requests.map(() => ({ enabled: true })));
  assert.deepEqual(env.cssCalls().map(call => call.method), ["insertCSS", "removeCSS", "insertCSS"]);
  for (const call of env.cssCalls()) assert.deepEqual(call.value, env.cssCalls()[0].value);
  assert.deepEqual([...env.sheets.values()], [1]);
  await worker.sync(); env.assertClean();
});

test("后台重启清空内存后，已有文档的关闭请求仍移除此前的 USER 样式", async () => {
  const env = environment(), originalWorker = env.startWorker();
  await originalWorker.sync();
  await originalWorker.apply({ initial: true });
  const originalInjection = env.cssCalls()[0].value;
  assert.equal(env.sheets.size, 1);
  env.setStored(enabledSettings(false));
  const restartedWorker = env.startWorker();
  await restartedWorker.sync();
  assert.equal(env.registrations.size, 0);
  assert.equal(env.sheets.size, 1, "注销提前注册本身不删除文档中已注入的样式");
  assert.deepEqual(await restartedWorker.apply(), { enabled: false });
  assert.deepEqual(env.cssCalls().at(-1), { method: "removeCSS", value: originalInjection });
  assert.equal(env.sheets.size, 0);
  await restartedWorker.apply();
  assert.equal(env.cssCalls().length, 2);
  env.assertClean();
});

test("后台在开启时重启后仍只保留一份 USER 样式，再关闭时完全移除", async () => {
  const env = environment(), originalWorker = env.startWorker();
  await originalWorker.sync();
  await originalWorker.apply({ initial: true });
  assert.deepEqual([...env.sheets.values()], [1]);
  const restartedWorker = env.startWorker();
  await restartedWorker.sync();
  assert.deepEqual(await restartedWorker.apply(), { enabled: true });
  const enabledCounts = [...env.sheets.values()];
  restartedWorker.changeSettings(enabledSettings(false));
  assert.deepEqual(await restartedWorker.apply(), { enabled: false });
  const disabledCounts = [...env.sheets.values()];
  assert.deepEqual({ enabledCounts, disabledCounts }, { enabledCounts: [1], disabledCounts: [] });
  const originalInjection = env.cssCalls()[0].value;
  for (const call of env.cssCalls()) assert.deepEqual(call.value, originalInjection);
  await restartedWorker.sync(); env.assertClean();
});

test("后台重启复用页面已确认的 USER 样式，保持原注入顺序并正常关闭", async () => {
  const env = environment(), originalWorker = env.startWorker();
  await originalWorker.sync(); await originalWorker.apply({ initial: true });
  const restartedWorker = env.startWorker(); await restartedWorker.sync();
  assert.deepEqual(await restartedWorker.apply({ userStyle: true }), { enabled: true });
  assert.deepEqual(env.cssCalls().map(call => call.method), ["insertCSS"]);
  restartedWorker.changeSettings(enabledSettings(false));
  assert.deepEqual(await restartedWorker.apply({ userStyle: true }), { enabled: false });
  assert.deepEqual(env.cssCalls().map(call => call.method), ["insertCSS", "removeCSS"]);
  assert.equal(env.sheets.size, 0); await restartedWorker.sync(); env.assertClean();
});

test("首次关闭的全新文档不额外移除样式，非首次关闭仍主动清理", async () => {
  const env = environment(enabledSettings(false)), worker = env.startWorker();
  await worker.sync();
  assert.deepEqual(await worker.apply({ initial: true }), { enabled: false });
  assert.equal(env.cssCalls().length, 0);
  assert.deepEqual(await worker.apply({ documentId: "existing-document" }), { enabled: false });
  assert.deepEqual(env.cssCalls().map(call => call.method), ["removeCSS"]);
  env.assertClean();
});

test("普通框架按自身网址匹配，空白与 srcdoc 框架按创建来源匹配", async () => {
  const env = environment({ enabled: false, siteRules: [{ domain: "example.com", mode: "on" }] });
  const worker = env.startWorker(); await worker.sync();
  for (const [documentId, url] of [["blank", "about:blank#section"], ["srcdoc", "about:srcdoc"]]) {
    assert.deepEqual(await worker.apply({ initial: true, documentId, url }), { enabled: true });
  }
  assert.deepEqual(await worker.apply({ initial: true, documentId: "other-site", url: "https://other.example.net" }), { enabled: false });
  assert.deepEqual(env.cssCalls().map(call => call.value.target.documentIds), [["blank"], ["srcdoc"]]);
  env.assertClean();
});

test("忽略外部来源、缺失文档和非本地存储事件，不使用额外 API 或权限", async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions.slice().sort(), ["activeTab", "scripting", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  const env = environment(), worker = env.startWorker(); await worker.sync();
  for (const sender of [{ id: "other-extension" }, { tab: undefined }, { documentId: undefined }]) {
    assert.equal(await worker.apply(sender), undefined);
  }
  assert.equal(await worker.message({ type: "unknown-message" }), undefined);
  worker.changeSettings(enabledSettings(false), "sync");
  assert.deepEqual(await worker.apply({ initial: true }), { enabled: true });
  assert.equal(env.cssCalls().length, 1);
  await worker.sync(); env.assertClean();
});
