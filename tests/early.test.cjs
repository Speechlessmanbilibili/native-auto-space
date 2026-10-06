const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const http = require("node:http");
const { chromium, executablePath } = require("./browser.cjs");
const root = path.resolve(__dirname, "..");
let context, worker, server, otherServer, port, otherPort;
const errors = [];
const authorStyles = {
  ordinary: "*{text-autospace:no-autospace}",
  important: "html body #t,html body #t::before,html body #search::placeholder{text-autospace:no-autospace!important}",
  layered: "@layer site-first,site-last;@layer site-first{html body #t,html body #t::before,html body #search::placeholder{text-autospace:no-autospace!important}}",
  inline: "*{text-autospace:no-autospace}"
};
function makeFixture(kind = "ordinary") {
  return `<!doctype html><meta charset="utf-8"><style>${authorStyles[kind]}body{font:24px Arial}#t::before{content:"中文Before"}</style>
    <p id=t${kind === "inline" ? ' style="text-autospace:no-autospace!important"' : ""}>中文English数字2026</p><input id=search placeholder="中文Search">
    <script>
      window.spacingSamples = [];
      function sampleSpacing(stage) {
        const value = getComputedStyle(t).textAutospace;
        spacingSamples.push({ stage, value, time: performance.now(), before: getComputedStyle(t,"::before").textAutospace,
          placeholder: getComputedStyle(search,"::placeholder").textAutospace });
        return value;
      }
      window.earlySpacing=sampleSpacing("first-script");
      requestAnimationFrame(()=>window.firstFrameSpacing=sampleSpacing("first-frame"));
    </script>`;
}
const fixture = makeFixture();
function serve() { return http.createServer((request, response) => {
  const kind = new URL(request.url, "http://example.com").searchParams.get("cascade") || "ordinary";
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(makeFixture(Object.hasOwn(authorStyles, kind) ? kind : "ordinary"));
}); }
before(async () => {
  server = serve(); otherServer = serve();
  await Promise.all([new Promise(r => server.listen(0, "127.0.0.1", r)), new Promise(r => otherServer.listen(0, "127.0.0.1", r))]);
  port = server.address().port; otherPort = otherServer.address().port;
  context = await chromium.launchPersistentContext("", { executablePath, headless: true,
    args: ["--disable-extensions-except=" + root, "--load-extension=" + root, "--no-proxy-server", "--host-resolver-rules=MAP example.com 127.0.0.1, MAP *.example.com 127.0.0.1, MAP *.example.net 127.0.0.1"] });
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  worker.on("console", x => { if (x.type() === "error") errors.push(x.text()); });
});
after(async () => { await context?.close(); await Promise.all([server && new Promise(r => server.close(r)), otherServer && new Promise(r => otherServer.close(r))]); });
async function settings(value) {
  await worker.evaluate(async value => {
    await chrome.storage.local.set({ settings: value });
    await new Promise(resolve => setTimeout(resolve, 30));
    await syncRegistration();
  }, value);
}
async function opened(host, targetPort = port, kind = "ordinary") {
  const page = await context.newPage();
  await page.goto(`http://${host}:${targetPort}/early?cascade=${kind}`);
  return page;
}
test("延迟 USER 700 毫秒，记录普通、重要、分层及行内样式的首段脚本、首帧和补充后间距", async t => {
  await settings({ enabled: true, siteRules: [] });
  await worker.evaluate(() => {
    globalThis.savedInsertCSS = chrome.scripting.insertCSS;
    globalThis.injected = [];
    const gates = [];
    globalThis.userInjectionsReleased = false;
    globalThis.releaseUserInjections = () => { userInjectionsReleased = true; for (const release of gates.splice(0)) release(); };
    const insert = chrome.scripting.insertCSS.bind(chrome.scripting);
    chrome.scripting.insertCSS = options => {
      const requestedAt = performance.now();
      // 至少延迟 700 毫秒，并等测试读到首帧再放行，避免慢速 CI 把后续 USER 当成提前样式。
      return Promise.all([new Promise(resolve => setTimeout(resolve, 700)), userInjectionsReleased ? Promise.resolve() : new Promise(resolve => gates.push(resolve))])
        .then(() => insert(options)).then(value => {
          injected.push({ origin: options.origin, delay: performance.now() - requestedAt });
          return value;
        });
    };
  });
  try {
    for (const kind of Object.keys(authorStyles)) {
      const count = await worker.evaluate(() => { userInjectionsReleased = false; return injected.length; });
      const page = await opened("example.com", port, kind);
      try {
        await page.waitForFunction(() => window.firstFrameSpacing);
        const injectedAtFirstFrame = await worker.evaluate(() => { const count = injected.length; releaseUserInjections(); return count; });
        await worker.evaluate(async count => {
          const deadline = performance.now() + 5000;
          while (injected.length === count && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        }, count);
        const injections = await worker.evaluate(() => injected);
        await page.evaluate(() => sampleSpacing("after-user-injection"));
        const samples = await page.evaluate(() => spacingSamples);
        // 先输出实测值，再做断言；失败时同样保留三个时点的记录。
        t.diagnostic(JSON.stringify({ browser: context.browser().version(), kind, injectedAtFirstFrame, injection: injections[count], samples }));
        // 行内重要声明是 AUTHOR 提前样式的真实边界，不能用普通规则冒充测试通过。
        const earlyExpected = kind === "inline" ? "no-autospace" : "normal";
        assert.equal(samples[0].value, earlyExpected, kind + " 首段脚本");
        assert.equal(samples[1].value, earlyExpected, kind + " 首帧");
        assert.equal(injectedAtFirstFrame, count, "首帧不得借用后续 USER 注入");
        assert.equal(injections.length, count + 1);
        assert.equal(injections[count].origin, "USER");
        assert.ok(injections[count].delay >= 700);
        assert.equal(samples.at(-1).value, "normal", kind + " USER 补充后");
        for (const sample of samples) {
          assert.equal(sample.before, "normal", kind + " 伪元素 " + sample.stage);
          assert.equal(sample.placeholder, "normal", kind + " 占位文字 " + sample.stage);
        }
        assert.equal(await page.locator("#t").textContent(), "中文English数字2026");
        assert.equal(await page.locator("#t").evaluate(el => getComputedStyle(el).fontFamily), "Arial");
      } finally { await page.close(); }
    }
  } finally { await worker.evaluate(() => { releaseUserInjections(); chrome.scripting.insertCSS = savedInsertCSS; }); }
});
test("USER 重要声明抵抗网页后续行内及样式表覆盖，关闭时完整恢复网页设置", async () => {
  await settings({ enabled: true, siteRules: [] });
  const page = await opened("example.com", port, "inline");
  try {
    await page.waitForFunction(() => getComputedStyle(t).textAutospace === "normal");
    assert.equal(await page.locator("#t").getAttribute("style"), "text-autospace:no-autospace!important");
    const result = await page.evaluate(() => {
      // 先由测试网页自行规范化行内序列化格式，再检查后续状态保持不变。
      t.style.setProperty("text-autospace", "no-autospace", "important");
      const original = t.getAttribute("style");
      const stylesheet = new CSSStyleSheet();
      stylesheet.replaceSync("@layer hostile{html body #t{text-autospace:no-autospace!important}}");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, stylesheet];
      const style = document.createElement("style");
      style.textContent = "html body #t{text-autospace:no-autospace!important}";
      document.head.prepend(style);
      const values = [];
      for (let i = 0; i < 20; i++) {
        t.style.setProperty("text-autospace", "no-autospace", "important");
        document.documentElement.setAttribute("data-native-auto-space-off", "");
        values.push(getComputedStyle(t).textAutospace);
      }
      return { original, final: t.getAttribute("style"), values };
    });
    assert.ok(result.values.every(value => value === "normal"), "网页同步写入后立即读取仍不能覆盖 USER 声明");
    assert.equal(result.original, result.final, "扩展不重写网站的行内样式");
    for (const enabled of [false, true, false]) {
      await settings({ enabled, siteRules: [] });
      await page.waitForFunction(expected => getComputedStyle(t).textAutospace === expected, enabled ? "normal" : "no-autospace");
    }
    assert.equal(await page.locator("#t").getAttribute("style"), result.original);
  } finally { await page.close(); }
});
test("重复应用不会压制用户或其他扩展后来提供的同等权重 USER 重要声明", async () => {
  await settings({ enabled: true, siteRules: [] });
  const page = await opened("example.com", port, "inline");
  const css = "* { text-autospace: no-autospace !important; }";
  let tabId;
  try {
    await page.waitForFunction(() => getComputedStyle(t).textAutospace === "normal");
    tabId = await worker.evaluate(async ({ url, css }) => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, css, origin: "USER" });
      return tab.id;
    }, { url: page.url(), css });
    assert.equal(await page.locator("#t").evaluate(node => getComputedStyle(node).textAutospace), "no-autospace");
    const repeated = await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId },
      func: () => chrome.runtime.sendMessage({ type: "auto-space-apply", initial: false }) }), tabId);
    assert.equal(repeated[0].result?.enabled, true);
    assert.equal(await page.locator("#t").evaluate(node => getComputedStyle(node).textAutospace), "no-autospace");
  } finally {
    if (tabId !== undefined) await worker.evaluate(({ tabId, css }) => chrome.scripting.removeCSS({ target: { tabId }, css, origin: "USER" }), { tabId, css });
    await page.close();
  }
});
test("记录网页离散过渡的浏览器行为，不以禁止全站动画伪造覆盖保证", async t => {
  await settings({ enabled: false, siteRules: [] });
  const page = await opened("example.com", port, "inline");
  try {
    await page.locator("#t").evaluate(node => {
      node.style.setProperty("transition", "text-autospace 10s allow-discrete", "important");
      getComputedStyle(node).textAutospace;
    });
    await settings({ enabled: true, siteRules: [] });
    const result = await worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      // 等待同文档的真实注入完成，不用固定睡眠猜测后台状态。
      return chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => {
        const state = await chrome.runtime.sendMessage({ type: "auto-space-apply", initial: false });
        const node = document.getElementById("t");
        return { enabled: state?.enabled, value: getComputedStyle(node).textAutospace, behavior: getComputedStyle(node).transitionBehavior,
          animations: node.getAnimations().map(animation => ({ type: animation.constructor.name, property: animation.transitionProperty })) };
      } });
    }, page.url());
    t.diagnostic(JSON.stringify({ browser: context.browser().version(), transitionDiagnostic: result[0].result }));
    assert.equal(result[0].result.enabled, true, "诊断必须确认 USER 注入成功");
    assert.equal(result[0].result.behavior, "allow-discrete", "保留网站自身的过渡设置");
  } finally { await page.close(); }
});
test("首次绘制按全局、子域名、显式端口、继承和同等规则顺序决定间距", async () => {
  await settings({ enabled: true, siteRules: [
    { domain: "example.com", mode: "off" }, { domain: "docs.example.com", mode: "on" },
    { domain: "docs.example.com:" + port, mode: "off" }, { domain: "docs.example.com:" + port, mode: "on" },
    { domain: "child.docs.example.com", mode: "inherit" }
  ] });
  for (const [host, targetPort, expected] of [["example.com", port, "no-autospace"], ["docs.example.com", port, "no-autospace"],
    ["docs.example.com", otherPort, "normal"], ["child.docs.example.com", port, "normal"], ["outer.example.net", port, "normal"]]) {
    const page = await opened(host, targetPort);
    assert.equal(await page.evaluate(() => earlySpacing), expected, host + ":" + targetPort);
    await page.close();
  }
  await settings({ enabled: false, siteRules: [{ domain: "example.com", mode: "on" }, { domain: "docs.example.com", mode: "inherit" }] });
  for (const [host, expected] of [["example.com", "normal"], ["docs.example.com", "no-autospace"], ["outer.example.net", "no-autospace"]]) {
    const page = await opened(host); assert.equal(await page.evaluate(() => earlySpacing), expected, host); await page.close();
  }
});
test("撤销提前注册后，已打开页面的反复关闭恢复作者间距，快速保存沿用最终配置", async () => {
  await settings({ enabled: true, siteRules: [] });
  const page = await opened("example.com");
  for (const enabled of [false, true, false, true]) {
    await settings({ enabled, siteRules: [] });
    await page.waitForFunction(expected => getComputedStyle(t).textAutospace === expected, enabled ? "normal" : "no-autospace");
  }
  await worker.evaluate(async () => {
    for (const enabled of [false, true, false]) await chrome.storage.local.set({ settings: { enabled, siteRules: [] } });
    await syncRegistration();
  });
  await page.waitForFunction(() => getComputedStyle(t).textAutospace === "no-autospace");
  assert.equal((await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length, 0);
  await page.close();
});
test("空白子框架按创建者来源提前注入，关闭后恢复原间距，IPv6 规则可以注册", async () => {
  await settings({ enabled: false, siteRules: [{ domain: "example.com", mode: "on" }, { domain: "[::1]:" + port, mode: "on" }] });
  const page = await opened("example.com");
  await page.evaluate(text => { const frame = document.createElement("iframe"); frame.id = "child"; frame.srcdoc = text; document.body.append(frame); }, fixture);
  const child = page.frameLocator("#child");
  await child.locator("#t").waitFor();
  assert.equal(await child.locator("#t").evaluate(() => earlySpacing), "normal");
  await settings({ enabled: false, siteRules: [] });
  await child.locator("#t").evaluate(async node => {
    while (getComputedStyle(node).textAutospace !== "no-autospace") await new Promise(resolve => requestAnimationFrame(resolve));
  });
  assert.equal(await child.locator("#t").evaluate(node => getComputedStyle(node).textAutospace), "no-autospace");
  await page.close();
});
test("后台停止后重新开页，持久注册仍在网站脚本之前生效", async () => {
  await settings({ enabled: true, siteRules: [] });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send("ServiceWorker.enable"); await session.send("ServiceWorker.stopAllWorkers");
  await page.goto(`http://example.com:${port}/cold`);
  assert.equal(await page.evaluate(() => earlySpacing), "normal");
  await session.detach(); await page.close();
});
test("提前注册和首屏注入没有后台错误", () => { assert.deepEqual(errors, []); });
