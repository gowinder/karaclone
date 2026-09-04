// 面板：纯静态单页（零构建、零依赖），Worker 直接 serve。
// 手写轻量 tRPC 客户端（superjson 仅处理 Date），登录/注册/书签管理。

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KaraClone 面板</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --border:#e2e5ea; --text:#1a1d21; --muted:#6b7280; --accent:#2563eb; --danger:#dc2626; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--text); }
  .container { max-width:720px; margin:0 auto; padding:24px 16px 64px; }
  header { display:flex; align-items:center; justify-content:space-between; padding:16px 0; border-bottom:1px solid var(--border); margin-bottom:24px; }
  header h1 { font-size:20px; font-weight:600; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:20px; margin-bottom:20px; }
  h2 { font-size:16px; font-weight:600; margin-bottom:14px; }
  label { display:block; font-size:13px; color:var(--muted); margin:10px 0 4px; }
  input { width:100%; padding:9px 12px; border:1px solid var(--border); border-radius:8px; font-size:14px; }
  input:focus { outline:2px solid var(--accent); outline-offset:-1px; border-color:transparent; }
  button { padding:9px 16px; border:none; border-radius:8px; font-size:14px; font-weight:500; cursor:pointer; background:var(--accent); color:#fff; margin-top:14px; }
  button.secondary { background:#e5e7eb; color:var(--text); }
  button.danger { background:transparent; color:var(--danger); border:1px solid var(--danger); }
  .row { display:flex; gap:10px; }
  .row > div { flex:1; }
  .error { color:var(--danger); font-size:13px; margin-top:8px; min-height:18px; }
  .bookmark { padding:14px 0; border-bottom:1px solid var(--border); }
  .bookmark:last-child { border-bottom:none; }
  .bookmark .title { font-size:15px; font-weight:500; }
  .bookmark .url { font-size:13px; color:var(--accent); word-break:break-all; }
  .bookmark .meta { font-size:12px; color:var(--muted); margin-top:4px; }
  .tag { display:inline-block; background:#eef2ff; color:#3730a3; border-radius:999px; padding:2px 10px; font-size:12px; margin-right:6px; }
  .hidden { display:none; }
  .tabs { display:flex; gap:8px; margin-bottom:16px; }
  .tab { flex:1; text-align:center; padding:10px; border:1px solid var(--border); border-radius:8px; cursor:pointer; background:var(--card); font-size:14px; }
  .tab.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  .empty { color:var(--muted); text-align:center; padding:24px 0; font-size:14px; }
  .muted { color:var(--muted); font-size:13px; }
  .provider-card { border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:12px; }
  .provider-card .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
  .provider-card .name { font-size:15px; font-weight:600; }
  .provider-card .badge { font-size:12px; color:var(--muted); }
  .provider-card .badge.ok { color:#15803d; }
  .provider-card .badge.no { color:var(--danger); }
  .provider-card .actions { display:flex; gap:8px; }
  .provider-card .actions button { margin-top:0; padding:6px 12px; font-size:13px; }
  .provider-card .edit-form { display:none; margin-top:10px; }
  .provider-card .edit-form.open { display:block; }
  .provider-card .edit-form .row { margin-bottom:8px; }
  .provider-card .edit-form .row > div { flex:1; }
  .provider-card .edit-form .hint { font-size:12px; color:var(--muted); margin-top:4px; }
  .provider-card .edit-form .err { color:var(--danger); font-size:12px; min-height:16px; margin-top:6px; }
  .provider-card .edit-form .ok { color:#15803d; font-size:12px; min-height:16px; margin-top:6px; }
  .provider-card .edit-form .fetch-row { display:flex; gap:8px; align-items:center; }
  .provider-card .edit-form .fetch-row button { margin-top:0; }
  .provider-card .edit-form .fetch-row .fetch-status { font-size:12px; color:var(--muted); }
  .provider-card .edit-form .model-row { display:flex; gap:8px; margin-top:8px; }
  .provider-card .edit-form .model-row select { flex:1; padding:8px; border:1px solid var(--border); border-radius:8px; font-size:13px; }
  .provider-card .edit-form .model-row .model-count { font-size:12px; color:var(--muted); align-self:center; white-space:nowrap; }
  .provider-card .edit-form .save-row { display:flex; gap:8px; align-items:center; margin-top:10px; }
  .provider-card .edit-form .save-row button { margin-top:0; }
  .provider-card .edit-form .save-row .save-status { font-size:12px; color:var(--muted); }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>KaraClone</h1>
    <button id="logout-btn" class="danger hidden">登出</button>
  </header>

  <div id="auth-view">
    <div class="tabs">
      <div id="tab-login" class="tab active">登录</div>
      <div id="tab-signup" class="tab">注册</div>
    </div>
    <div class="card">
      <form id="login-form">
        <h2>登录</h2>
        <label for="login-email">邮箱</label>
        <input id="login-email" type="email" autocomplete="email" required>
        <label for="login-password">密码</label>
        <input id="login-password" type="password" autocomplete="current-password" required>
        <button type="submit">登录</button>
        <div class="error" id="login-error"></div>
      </form>
      <form id="signup-form" class="hidden">
        <h2>注册</h2>
        <label for="signup-name">昵称</label>
        <input id="signup-name" type="text" required>
        <label for="signup-email">邮箱</label>
        <input id="signup-email" type="email" autocomplete="email" required>
        <label for="signup-password">密码（至少 8 位）</label>
        <input id="signup-password" type="password" autocomplete="new-password" required>
        <label for="signup-confirm">确认密码</label>
        <input id="signup-confirm" type="password" autocomplete="new-password" required>
        <button type="submit">注册</button>
        <div class="error" id="signup-error"></div>
      </form>
    </div>
  </div>

  <div id="app-view" class="hidden">
    <div class="tabs">
      <div id="tab-bookmarks" class="tab active">书签</div>
      <div id="tab-settings" class="tab">设置</div>
    </div>
    <div id="bookmarks-view">
      <div class="card">
        <h2>保存书签</h2>
      <form id="save-form">
        <label for="save-url">URL</label>
        <input id="save-url" type="url" placeholder="https://example.com" required>
        <label for="save-title">标题（可选）</label>
        <input id="save-title" type="text" placeholder="页面标题">
        <button type="submit">保存</button>
        <div class="error" id="save-error"></div>
      </form>
    </div>
      <div class="card">
        <h2>书签</h2>
        <div id="bookmark-list"><div class="empty">加载中…</div></div>
      </div>
    </div>
    <div id="settings-view" class="hidden">
      <div class="card">
        <h2>AI 提供商</h2>
        <div id="provider-list"><div class="empty">加载中…</div></div>
      </div>
      <div class="card">
        <h2>模型选择</h2>
        <label for="chat-model-select">对话模型（LLM，打标签/摘要）</label>
        <select id="chat-model-select"><option value="">先配置并拉取模型</option></select>
        <label for="embed-model-select">向量模型（Embedding，语义搜索，可选）</label>
        <select id="embed-model-select"><option value="">不使用向量模型</option></select>
        <button type="button" id="save-selection">保存模型选择</button>
        <div class="error" id="llm-error"></div>
        <div class="muted" id="llm-status"></div>
      </div>
    </div>
  </div>
</div>

<script>
(function () {
  var base = location.origin;
  var apiKey = localStorage.getItem("karaclone_api_key") || "";
  var user = null;

  // ---- superjson（仅 Date）----
  // tRPC v11 HTTP 协议：json 字段直接是数据（transformer 由服务端处理）。
  // 请求无需 superjson 包装；响应若有 meta.values 需还原 Date。
  function deserializeSuperjson(payload) {
    if (!payload || typeof payload !== "object" || !("json" in payload)) return payload;
    var json = payload.json, meta = payload.meta;
    if (!meta || !meta.values) return json;
    var i = 0;
    function walk(v) {
      if (meta.values[i] === "Date") { i++; return new Date(v); }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        var o = {};
        Object.keys(v).forEach(function (k) { o[k] = walk(v[k]); });
        return o;
      }
      return v;
    }
    return walk(json);
  }

  // ---- tRPC 客户端 ----
  async function trpc(path, input, method) {
    var headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    var url = base + "/api/trpc/" + path + "?batch=1";
    var body;
    if (method === "GET") {
      url += "&input=" + encodeURIComponent(JSON.stringify({ "0": { json: input || {} } }));
    } else {
      body = JSON.stringify({ "0": { json: input || {} } });
    }
    var res = await fetch(url, { method: method || "POST", headers: headers, body: body });
    var data = await res.json();
    var item = data[0];
    if (item.error) {
      var msg = (item.error.json && item.error.json.message) || item.error.message || "请求失败";
      var err = new Error(msg);
      err.code = item.error.json && item.error.json.data && item.error.json.data.code;
      throw err;
    }
    return deserializeSuperjson(item.result.data.json);
  }

  // ---- 视图切换 ----
  function showAuth() {
    document.getElementById("auth-view").classList.remove("hidden");
    document.getElementById("app-view").classList.add("hidden");
    document.getElementById("logout-btn").classList.add("hidden");
  }
  function showApp() {
    document.getElementById("auth-view").classList.add("hidden");
    document.getElementById("app-view").classList.remove("hidden");
    document.getElementById("logout-btn").classList.remove("hidden");
  }

  // ---- 登录/注册 ----
  document.getElementById("tab-login").addEventListener("click", function () {
    document.getElementById("tab-login").classList.add("active");
    document.getElementById("tab-signup").classList.remove("active");
    document.getElementById("login-form").classList.remove("hidden");
    document.getElementById("signup-form").classList.add("hidden");
  });
  document.getElementById("tab-signup").addEventListener("click", function () {
    document.getElementById("tab-signup").classList.add("active");
    document.getElementById("tab-login").classList.remove("active");
    document.getElementById("signup-form").classList.remove("hidden");
    document.getElementById("login-form").classList.add("hidden");
  });

  document.getElementById("login-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var errEl = document.getElementById("login-error");
    errEl.textContent = "";
    try {
      var email = document.getElementById("login-email").value.trim();
      var password = document.getElementById("login-password").value;
      var result = await trpc("apiKeys.exchange", {
        keyName: "Dashboard: (" + Math.random().toString(36).slice(2, 8) + ")",
        email: email,
        password: password
      });
      apiKey = result.key;
      localStorage.setItem("karaclone_api_key", apiKey);
      await loadApp();
    } catch (err) {
      errEl.textContent = err.message || "登录失败";
    }
  });

  document.getElementById("signup-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var errEl = document.getElementById("signup-error");
    errEl.textContent = "";
    var password = document.getElementById("signup-password").value;
    var confirm = document.getElementById("signup-confirm").value;
    if (password !== confirm) { errEl.textContent = "两次密码不一致"; return; }
    try {
      await trpc("users.create", {
        name: document.getElementById("signup-name").value.trim(),
        email: document.getElementById("signup-email").value.trim(),
        password: password,
        confirmPassword: confirm
      });
      document.getElementById("tab-login").click();
      document.getElementById("login-email").value = document.getElementById("signup-email").value.trim();
      document.getElementById("login-password").value = "";
      document.getElementById("login-error").textContent = "注册成功，请登录";
    } catch (err) {
      errEl.textContent = err.message || "注册失败";
    }
  });

  document.getElementById("logout-btn").addEventListener("click", function () {
    apiKey = "";
    localStorage.removeItem("karaclone_api_key");
    showAuth();
  });

  // ---- 设置 tab ----
  var PROVIDER_META = {
    "workers-ai": { name: "Workers AI", desc: "Cloudflare 内置，免费额度", defaultUrl: "" },
    "openrouter": { name: "OpenRouter", desc: "聚合多家模型，按量付费", defaultUrl: "https://openrouter.ai/api/v1" },
    "ollama-cloud": { name: "Ollama Cloud", desc: "Ollama 官方云服务", defaultUrl: "https://ollama.com" }
  };
  var providerModels = {}; // provider -> { chat: [], embedding: [] }

  document.getElementById("tab-bookmarks").addEventListener("click", function () {
    document.getElementById("tab-bookmarks").classList.add("active");
    document.getElementById("tab-settings").classList.remove("active");
    document.getElementById("bookmarks-view").classList.remove("hidden");
    document.getElementById("settings-view").classList.add("hidden");
  });
  document.getElementById("tab-settings").addEventListener("click", function () {
    document.getElementById("tab-settings").classList.add("active");
    document.getElementById("tab-bookmarks").classList.remove("active");
    document.getElementById("settings-view").classList.remove("hidden");
    document.getElementById("bookmarks-view").classList.add("hidden");
    loadLlmConfig();
  });

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderProviderList(providers) {
    var list = document.getElementById("provider-list");
    var html = "";
    Object.keys(PROVIDER_META).forEach(function (p) {
      var meta = PROVIDER_META[p];
      var cfg = providers.find(function (x) { return x.provider === p; });
      var badge = cfg
        ? '<span class="badge ok">已配置' + (cfg.apiKeyConfigured ? " · Key 已存" : "") + "</span>"
        : '<span class="badge no">未配置</span>';
      html +=
        '<div class="provider-card" data-provider="' + p + '">' +
          '<div class="head">' +
            '<div><div class="name">' + meta.name + "</div><div class='badge'>" + meta.desc + "</div></div>" +
            '<div class="actions">' + badge +
              '<button type="button" class="secondary" data-act="edit">' + (cfg ? "编辑" : "配置") + "</button>" +
            "</div>" +
          "</div>" +
          '<div class="edit-form">' +
            '<div class="row">' +
              '<div><label>Base URL</label><input type="url" data-f="url" placeholder="' + meta.defaultUrl + '"></div>' +
              '<div><label>API Key（留空保持不变）</label><input type="password" data-f="key" autocomplete="off" placeholder="sk-..."></div>' +
            "</div>" +
            '<div class="fetch-row">' +
              '<button type="button" class="secondary" data-act="fetch">拉取模型列表</button>' +
              '<span class="fetch-status"></span>' +
            "</div>" +
            '<div class="model-row">' +
              '<select data-f="chat"><option value="">对话模型</option></select>' +
              '<select data-f="embed"><option value="">向量模型</option></select>' +
              '<span class="model-count"></span>' +
            "</div>" +
            '<div class="save-row">' +
              '<button type="button" data-act="save">保存</button>' +
              '<span class="save-status"></span>' +
            "</div>" +
            '<div class="err"></div>' +
          "</div>" +
        "</div>";
    });
    list.innerHTML = html;
    list.querySelectorAll(".provider-card").forEach(function (card) {
      var p = card.dataset.provider;
      var cfg = providers.find(function (x) { return x.provider === p; });
      if (cfg && cfg.baseUrl) card.querySelector('[data-f="url"]').value = cfg.baseUrl;
      card.querySelector('[data-act="edit"]').addEventListener("click", function () {
        card.querySelector(".edit-form").classList.toggle("open");
      });
      card.querySelector('[data-act="fetch"]').addEventListener("click", function () { fetchModels(card, p); });
      card.querySelector('[data-act="save"]').addEventListener("click", function () { saveProvider(card, p); });
    });
  }

  async function fetchModels(card, provider) {
    var errEl = card.querySelector(".err");
    var statusEl = card.querySelector(".fetch-status");
    errEl.textContent = "";
    statusEl.textContent = "拉取中…";
    try {
      // 先保存当前表单（含新填的 key），再拉取
      var url = card.querySelector('[data-f="url"]').value.trim() || undefined;
      var key = card.querySelector('[data-f="key"]').value;
      var payload = { provider: provider };
      if (url) payload.baseUrl = url;
      if (key) payload.apiKey = key;
      await trpc("llm.setProviderConfig", payload);
      card.querySelector('[data-f="key"]').value = "";
      var data = await trpc("llm.listModels", { provider: provider }, "GET");
      providerModels[provider] = {
        chat: data.models.filter(function (m) { return m.kind === "chat"; }),
        embedding: data.models.filter(function (m) { return m.kind === "embedding"; })
      };
      fillCardModels(card, provider);
      statusEl.textContent = "对话 " + providerModels[provider].chat.length + " 个，向量 " + providerModels[provider].embedding.length + " 个";
    } catch (err) {
      errEl.textContent = err.message || "拉取失败";
      statusEl.textContent = "";
    }
  }

  function fillCardModels(card, provider) {
    var m = providerModels[provider];
    if (!m) return;
    var chatSel = card.querySelector('[data-f="chat"]');
    var embedSel = card.querySelector('[data-f="embed"]');
    chatSel.innerHTML = "";
    embedSel.innerHTML = "";
    if (m.chat.length) {
      m.chat.forEach(function (x) {
        var o = document.createElement("option");
        o.value = x.id;
        o.textContent = x.name;
        chatSel.appendChild(o);
      });
    } else {
      var none = document.createElement("option");
      none.value = "";
      none.textContent = "无对话模型";
      chatSel.appendChild(none);
    }
    if (m.embedding.length) {
      m.embedding.forEach(function (x) {
        var o = document.createElement("option");
        o.value = x.id;
        o.textContent = x.name;
        embedSel.appendChild(o);
      });
    } else {
      var none2 = document.createElement("option");
      none2.value = "";
      none2.textContent = "无向量模型";
      embedSel.appendChild(none2);
    }
  }

  async function saveProvider(card, provider) {
    var errEl = card.querySelector(".err");
    var statusEl = card.querySelector(".save-status");
    errEl.textContent = "";
    try {
      var url = card.querySelector('[data-f="url"]').value.trim() || undefined;
      var key = card.querySelector('[data-f="key"]').value;
      var payload = { provider: provider };
      if (url) payload.baseUrl = url;
      if (key) payload.apiKey = key;
      await trpc("llm.setProviderConfig", payload);
      card.querySelector('[data-f="key"]').value = "";
      statusEl.textContent = "已保存";
      loadLlmConfig();
    } catch (err) {
      errEl.textContent = err.message || "保存失败";
    }
  }

  function fillSelectionSelects(selection) {
    var chatSel = document.getElementById("chat-model-select");
    var embedSel = document.getElementById("embed-model-select");
    chatSel.innerHTML = "";
    embedSel.innerHTML = "";
    // 对话模型：聚合所有已拉取 provider 的 chat 模型
    var chatOpts = [];
    Object.keys(providerModels).forEach(function (p) {
      providerModels[p].chat.forEach(function (x) {
        chatOpts.push({ provider: p, id: x.id, name: x.name });
      });
    });
    if (chatOpts.length) {
      chatOpts.forEach(function (x) {
        var o = document.createElement("option");
        o.value = x.provider + "::" + x.id;
        o.textContent = "[" + (PROVIDER_META[x.provider] || {}).name + "] " + x.name;
        chatSel.appendChild(o);
      });
      var cur = selection.chatProvider + "::" + selection.chatModel;
      if (chatOpts.some(function (x) { return x.provider + "::" + x.id === cur; })) {
        chatSel.value = cur;
      }
    } else {
      var none = document.createElement("option");
      none.value = "";
      none.textContent = "先在上方配置 provider 并拉取模型";
      chatSel.appendChild(none);
    }
    // 向量模型：聚合所有已拉取 provider 的 embedding 模型
    var embOpts = [];
    Object.keys(providerModels).forEach(function (p) {
      providerModels[p].embedding.forEach(function (x) {
        embOpts.push({ provider: p, id: x.id, name: x.name });
      });
    });
    var noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "不使用向量模型";
    embedSel.appendChild(noneOpt);
    embOpts.forEach(function (x) {
      var o = document.createElement("option");
      o.value = x.provider + "::" + x.id;
      o.textContent = "[" + (PROVIDER_META[x.provider] || {}).name + "] " + x.name;
      embedSel.appendChild(o);
    });
    if (selection.embeddingProvider && selection.embeddingModel) {
      var cur = selection.embeddingProvider + "::" + selection.embeddingModel;
      if (embOpts.some(function (x) { return x.provider + "::" + x.id === cur; })) {
        embedSel.value = cur;
      }
    }
  }

  document.getElementById("save-selection").addEventListener("click", async function () {
    var errEl = document.getElementById("llm-error");
    var statusEl = document.getElementById("llm-status");
    errEl.textContent = "";
    try {
      var chatSel = document.getElementById("chat-model-select");
      var embedSel = document.getElementById("embed-model-select");
      if (!chatSel.value) throw new Error("请先选择对话模型");
      var chatParts = chatSel.value.split("::");
      var payload = {
        chatProvider: chatParts[0],
        chatModel: chatParts[1]
      };
      if (embedSel.value) {
        var parts = embedSel.value.split("::");
        payload.embeddingProvider = parts[0];
        payload.embeddingModel = parts[1];
      }
      await trpc("llm.setSelection", payload);
      statusEl.textContent = "模型选择已保存";
    } catch (err) {
      errEl.textContent = err.message || "保存失败";
    }
  });

  var selection = null;

  async function loadLlmConfig() {
    var errEl = document.getElementById("llm-error");
    try {
      var cfg = await trpc("llm.getConfigs", {}, "GET");
      selection = cfg.selection;
      renderProviderList(cfg.providers);
      // 自动拉取已配置 provider 的模型列表（填充选择下拉）
      var configured = cfg.providers.filter(function (p) { return p.apiKeyConfigured; });
      for (var i = 0; i < configured.length; i++) {
        var p = configured[i].provider;
        try {
          var data = await trpc("llm.listModels", { provider: p }, "GET");
          providerModels[p] = {
            chat: data.models.filter(function (m) { return m.kind === "chat"; }),
            embedding: data.models.filter(function (m) { return m.kind === "embedding"; })
          };
        } catch (e) { /* 拉取失败不阻塞 */ }
      }
      fillSelectionSelects(selection);
    } catch (err) {
      errEl.textContent = err.message || "加载配置失败";
    }
  }

  // ---- 书签 ----
  document.getElementById("save-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var errEl = document.getElementById("save-error");
    errEl.textContent = "";
    try {
      await trpc("bookmarks.createBookmark", {
        type: "link",
        url: document.getElementById("save-url").value.trim(),
        title: document.getElementById("save-title").value.trim() || null,
        source: "web"
      });
      document.getElementById("save-url").value = "";
      document.getElementById("save-title").value = "";
      await loadBookmarks();
    } catch (err) {
      errEl.textContent = err.message || "保存失败";
    }
  });

  async function loadBookmarks() {
    var listEl = document.getElementById("bookmark-list");
    listEl.innerHTML = '<div class="empty">加载中…</div>';
    try {
      var data = await trpc("bookmarks.getBookmarks", { limit: 50, archived: false }, "GET");
      var bookmarks = data.bookmarks || [];
      if (!bookmarks.length) {
        listEl.innerHTML = '<div class="empty">暂无书签</div>';
        return;
      }
      listEl.innerHTML = "";
      bookmarks.forEach(function (bm) {
        var div = document.createElement("div");
        div.className = "bookmark";
        var url = (bm.content && bm.content.url) || bm.url || "";
        var title = bm.title || url || "(无标题)";
        var date = bm.createdAt ? new Date(bm.createdAt).toLocaleString() : "";
        var tags = (bm.tags || []).map(function (t) {
          return '<span class="tag">' + escapeHtml(t.name) + "</span>";
        }).join("");
        div.innerHTML =
          '<div class="title">' + escapeHtml(title) + "</div>" +
          (url ? '<div class="url"><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(url) + "</a></div>" : "") +
          '<div class="meta">' + escapeHtml(date) + " " + tags + "</div>";
        listEl.appendChild(div);
      });
    } catch (err) {
      listEl.innerHTML = '<div class="empty">加载失败：' + escapeHtml(err.message || "未知错误") + "</div>";
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  async function loadApp() {
    try {
      user = await trpc("users.whoami", {}, "GET");
      showApp();
      await loadBookmarks();
    } catch (err) {
      apiKey = "";
      localStorage.removeItem("karaclone_api_key");
      showAuth();
    }
  }

  if (apiKey) {
    loadApp();
  } else {
    showAuth();
  }
})();
</script>
</body>
</html>
`;

export async function handleDashboard(_env: Env): Promise<Response> {
  return new Response(DASHBOARD_HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
