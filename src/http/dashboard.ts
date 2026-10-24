// 面板：纯静态单页（零构建、零依赖），Worker 直接 serve。
// 手写轻量 tRPC 客户端（superjson 仅处理 Date），登录/注册/书签管理。
// 布局：桌面左侧导航（书签/设置/账户），移动端底部 Tab Bar；书签为默认主页。
// 设计：zinc 中性基底 + 单一暖橙 accent；SVG 图标（无 emoji）；移动端首屏优先。

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0c0a09">
<title>KaraClone · 书签</title>
<style>
  :root {
    --bg:#f5f5f4; --bg-deep:#efece8; --surface:#ffffff; --surface-2:#fafaf9;
    --border:#e7e5e4; --border-strong:#d6d3d1;
    --text:#1c1917; --text-2:#57534e; --text-3:#a8a29e;
    --accent:#ea580c; --accent-strong:#c2410c; --accent-soft:#fff7ed; --accent-border:#fed7aa;
    --danger:#dc2626; --danger-soft:#fef2f2; --success:#15803d; --success-soft:#f0fdf4;
    --warn:#b45309; --warn-soft:#fffbeb;
    --radius-lg:18px; --radius:12px; --radius-sm:8px;
    --shadow-xs:0 1px 2px rgba(28,25,23,.04);
    --shadow-sm:0 1px 2px rgba(28,25,23,.04),0 4px 12px -4px rgba(28,25,23,.06);
    --shadow-md:0 2px 4px rgba(28,25,23,.04),0 12px 32px -12px rgba(28,25,23,.14);
    --nav-w:244px; --topbar-h:60px;
    --spring:cubic-bezier(.16,1,.3,1);
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  html { scroll-behavior:smooth; }
  body {
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
    background:var(--bg); color:var(--text); -webkit-font-smoothing:antialiased; line-height:1.55;
    min-height:100dvh;
  }
  .hidden { display:none !important; }
  .muted { color:var(--text-2); font-size:13px; }
  .mono { font-variant-numeric:tabular-nums; }

  /* ============ 图标 ============ */
  .ic { width:18px; height:18px; flex:none; }
  .ic-sm { width:15px; height:15px; flex:none; }
  .ic path, .ic circle, .ic rect, .ic line, .ic polyline, .ic-sm path, .ic-sm circle, .ic-sm line { stroke:currentColor; fill:none; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; }

  /* ============ 认证页（分割屏） ============ */
  .auth-wrap { display:flex; min-height:100dvh; }
  .auth-aside {
    display:none;
    width:42%; min-width:380px;
    background:linear-gradient(160deg,#201a15 0%,#0c0a09 72%);
    color:#fafaf9;
    padding:56px 48px;
    flex-direction:column;
    justify-content:space-between;
    position:relative; overflow:hidden;
  }
  .auth-aside::after {
    content:""; position:absolute; inset:0; pointer-events:none;
    background:radial-gradient(720px 420px at 82% 12%, rgba(234,88,12,.22), transparent 62%),
               radial-gradient(560px 380px at 8% 92%, rgba(234,88,12,.10), transparent 60%);
  }
  .auth-aside .brand-lg { display:flex; align-items:center; gap:10px; font-size:19px; font-weight:650; letter-spacing:-.02em; position:relative; z-index:1; }
  .auth-aside .mark { width:32px; height:32px; border-radius:9px; background:var(--accent); display:flex; align-items:center; justify-content:center; color:#fff; box-shadow:0 0 0 1px rgba(255,255,255,.14) inset, 0 8px 24px -8px rgba(234,88,12,.55); }
  .auth-aside blockquote { position:relative; z-index:1; max-width:34ch; }
  .auth-aside blockquote p { font-size:26px; line-height:1.35; font-weight:600; letter-spacing:-.02em; text-wrap:balance; }
  .auth-aside blockquote footer { margin-top:18px; font-size:13px; color:rgba(250,250,249,.52); }
  .auth-main { flex:1; display:flex; align-items:center; justify-content:center; padding:40px 20px 64px; }
  @media (min-width:1024px) { .auth-aside { display:flex; } }
  .auth-box { width:100%; max-width:400px; }
  .auth-brand { display:flex; align-items:center; gap:9px; margin-bottom:28px; }
  .auth-brand .mark { width:28px; height:28px; border-radius:8px; background:var(--accent); display:flex; align-items:center; justify-content:center; color:#fff; }
  .auth-brand span { font-size:16px; font-weight:650; letter-spacing:-.02em; }
  .auth-box h2 { font-size:22px; font-weight:650; letter-spacing:-.02em; margin-bottom:4px; }
  .auth-box .sub { font-size:13px; color:var(--text-2); margin-bottom:22px; }
  .form-block { display:flex; flex-direction:column; gap:16px; }
  .field { display:flex; flex-direction:column; gap:5px; }
  .field > label { font-size:12px; font-weight:550; color:var(--text-2); letter-spacing:.01em; }
  .field > input {
    width:100%; padding:10px 13px; border:1px solid var(--border-strong); border-radius:10px;
    font-size:14px; background:var(--surface); color:var(--text); font-family:inherit;
    transition:border-color .15s var(--spring), box-shadow .15s var(--spring);
  }
  .field > input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(234,88,12,.12); }
  .field > textarea {
    width:100%; padding:9px 13px; border:1px solid var(--border-strong); border-radius:10px;
    font-size:14px; background:var(--surface); color:var(--text); font-family:inherit; resize:vertical; min-height:52px;
    transition:border-color .15s var(--spring), box-shadow .15s var(--spring);
  }
  .field > textarea:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(234,88,12,.12); }
  .btn {
    display:inline-flex; align-items:center; justify-content:center; gap:7px;
    padding:10px 16px; border:none; border-radius:10px; font-size:14px; font-weight:550;
    cursor:pointer; background:var(--accent); color:#fff; font-family:inherit;
    transition:background .15s var(--spring), transform .1s var(--spring), opacity .15s, box-shadow .15s;
  }
  .btn:hover { background:var(--accent-strong); }
  .btn:active { transform:scale(.98); }
  .btn:disabled { opacity:.55; cursor:not-allowed; }
  .btn.block { width:100%; }
  .btn.ghost { background:transparent; color:var(--text-2); }
  .btn.ghost:hover { background:var(--surface-2); color:var(--text); }
  .btn.secondary { background:var(--surface); color:var(--text); border:1px solid var(--border-strong); }
  .btn.secondary:hover { background:var(--surface-2); border-color:var(--text-3); }
  .btn.danger-ghost { background:transparent; color:var(--danger); border:1px solid rgba(220,38,38,.35); }
  .btn.danger-ghost:hover { background:var(--danger-soft); }
  .btn.sm { padding:5px 11px; font-size:12.5px; border-radius:8px; }
  .error { color:var(--danger); font-size:13px; min-height:16px; }
  .ok { color:var(--success); font-size:13px; min-height:16px; }
  .error:not(:empty):before { content:""; }
  .hint { font-size:12px; color:var(--text-3); }
  .auth-foot { margin-top:6px; font-size:13px; color:var(--text-3); text-align:center; }
  .auth-foot a { color:var(--accent-strong); cursor:pointer; text-decoration:none; }
  .auth-foot a:hover { text-decoration:underline; }

  /* ============ 主应用骨架 ============ */
  .app { display:flex; min-height:100dvh; }

  /* 桌面侧栏 */
  .sidebar {
    display:none;
    position:fixed; top:0; bottom:0; left:0; width:var(--nav-w);
    flex-direction:column;
    background:var(--surface); border-right:1px solid var(--border);
    padding:22px 14px 16px; z-index:30;
  }
  .sidebar .brand { display:flex; align-items:center; gap:9px; padding:2px 10px 20px; }
  .sidebar .brand .mark { width:30px; height:30px; border-radius:9px; background:var(--accent); display:flex; align-items:center; justify-content:center; color:#fff; box-shadow:0 6px 18px -6px rgba(234,88,12,.5); }
  .sidebar .brand .bn { font-size:16px; font-weight:650; letter-spacing:-.02em; }
  .nav-group { display:flex; flex-direction:column; gap:2px; }
  .nav-group-label { font-size:11px; font-weight:600; color:var(--text-3); letter-spacing:.06em; text-transform:uppercase; padding:14px 12px 6px; }
  .nav-item {
    display:flex; align-items:center; gap:10px; width:100%;
    padding:9px 12px; border:none; border-radius:10px; background:transparent;
    font-size:14px; font-weight:500; color:var(--text-2); cursor:pointer; font-family:inherit;
    transition:background .15s var(--spring), color .15s;
  }
  .nav-item:hover { background:var(--bg); color:var(--text); }
  .nav-item.active { background:var(--accent-soft); color:var(--accent-strong); font-weight:600; }
  .nav-item .nav-badge { margin-left:auto; font-size:11px; font-weight:600; color:var(--text-3); background:var(--bg); border-radius:999px; padding:1px 8px; }
  .sidebar-foot { margin-top:auto; padding-top:16px; border-top:1px solid var(--border); }
  .user-row { display:flex; align-items:center; gap:10px; padding:8px 12px 4px; }
  .avatar {
    width:34px; height:34px; border-radius:10px; flex:none;
    background:linear-gradient(150deg,var(--accent-soft),var(--accent-border));
    color:var(--accent-strong); display:flex; align-items:center; justify-content:center;
    font-size:14px; font-weight:650; position:relative;
  }
  .avatar .dot { position:absolute; right:-1px; bottom:-1px; width:9px; height:9px; border-radius:50%; background:var(--success); border:2px solid var(--surface); animation:pulse 2.4s var(--spring) infinite; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.45; } }
  .user-row .u-name { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .user-row .u-mail { font-size:11.5px; color:var(--text-3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .user-row { cursor:pointer; border-radius:10px; transition:background .15s var(--spring); }
  .user-row:hover { background:var(--bg); }
  .ver { padding:10px 12px 2px; font-size:11px; color:var(--text-3); font-variant-numeric:tabular-nums; letter-spacing:.02em; }

  /* 内容区 */
  .main { flex:1; min-width:0; margin-left:0; display:flex; flex-direction:column; }
  .topbar {
    display:none; align-items:center; justify-content:space-between;
    height:var(--topbar-h); padding:0 24px;
    position:sticky; top:0; z-index:20;
    background:rgba(245,245,244,.82); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
    border-bottom:1px solid var(--border);
  }
  .topbar .page-title { font-size:15px; font-weight:600; letter-spacing:-.01em; }
  .content { width:100%; max-width:860px; padding:26px 18px 96px; }
  @media (min-width:768px) {
    .sidebar { display:flex; }
    .topbar { display:flex; }
    .main { margin-left:var(--nav-w); }
    .content { padding:32px 40px 64px; }
  }

  /* ============ 书签视图 ============ */
  .section-head { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:16px; }
  .section-head h2 { font-size:17px; font-weight:650; letter-spacing:-.02em; }
  .section-head .count-lbl { font-size:12.5px; color:var(--text-3); }

  .quick-save {
    background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
    padding:20px; margin-bottom:26px; box-shadow:var(--shadow-xs);
  }
  .quick-save .qs-head { display:flex; align-items:center; gap:8px; margin-bottom:14px; }
  .quick-save .qs-head .ic { color:var(--accent); }
  .quick-save .qs-head h3 { font-size:14px; font-weight:600; letter-spacing:-.01em; }
  .qs-form { display:flex; flex-direction:column; gap:12px; }
  .qs-row { display:grid; grid-template-columns:1fr; gap:12px; }
  @media (min-width:560px) { .qs-row { grid-template-columns:2fr 1fr; } }
  .qs-row .field > input { padding:10px 13px; border-radius:10px; }
  .qs-submit-row { display:flex; align-items:center; gap:12px; }
  .qs-submit-row .error { margin:0; }

  .bookmark-card {
    background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
    padding:16px 18px; margin-bottom:12px; box-shadow:var(--shadow-xs);
    transition:border-color .2s var(--spring), box-shadow .2s var(--spring);
  }
  .bookmark-card:hover { border-color:var(--border-strong); box-shadow:var(--shadow-sm); }
  .bm-top { display:flex; align-items:flex-start; gap:12px; }
  .bm-favicon {
    width:34px; height:34px; border-radius:9px; flex:none; margin-top:1px;
    background:var(--surface-2); border:1px solid var(--border);
    display:flex; align-items:center; justify-content:center; overflow:hidden;
  }
  .bm-favicon img { width:18px; height:18px; border-radius:4px; }
  .bm-favicon .ic { width:15px; height:15px; color:var(--text-3); }
  .bm-main { flex:1; min-width:0; }
  .bm-title-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }
  .bm-title { font-size:15px; font-weight:600; letter-spacing:-.01em; cursor:pointer; min-width:0; overflow-wrap:anywhere; }
  .bm-title:hover { color:var(--accent-strong); }
  .bm-url { font-size:12px; color:var(--text-3); word-break:break-all; margin-top:3px; }
  .bm-url a { color:inherit; text-decoration:none; }
  .bm-url a:hover { color:var(--accent-strong); text-decoration:underline; }
  .bm-meta { display:flex; align-items:center; gap:7px; margin-top:8px; flex-wrap:wrap; }
  .bm-date { font-size:12px; color:var(--text-3); font-variant-numeric:tabular-nums; }
  .bm-meta .sep { width:3px; height:3px; border-radius:50%; background:var(--border-strong); }
  .chip {
    display:inline-flex; align-items:center; gap:4px; background:var(--accent-soft);
    color:var(--accent-strong); border:1px solid transparent; border-radius:999px;
    padding:2px 9px; font-size:12px; font-weight:500;
  }
  .chip[data-act="edit-tags"] { cursor:pointer; }
  .chip[data-act="edit-tags"]:hover { border-color:var(--accent); }
  .chip[data-act="edit-tags"] .ic-edit { width:10px; height:10px; opacity:.5; }
  .chip[data-act="edit-tags"]:hover .ic-edit { opacity:.9; }
  .chip-x { background:none; border:none; color:inherit; opacity:.55; cursor:pointer; padding:0 0 0 2px; font-size:13px; line-height:1; }
  .chip-x:hover { opacity:1; }
  .tag-editor { margin-top:8px; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:10px; display:flex; flex-direction:column; gap:8px; }
  .te-current { display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
  .te-input-row { display:flex; gap:6px; }
  .te-input { flex:1; padding:6px 10px; border:1px solid var(--border-strong); border-radius:8px; font-size:13px; background:var(--bg); color:var(--text); font-family:inherit; }
  .te-input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(234,88,12,.12); }
  .te-all { display:flex; flex-wrap:wrap; gap:5px; max-height:120px; overflow-y:auto; }
  .tag-opt { border:1px solid var(--border); background:transparent; color:var(--text-2); border-radius:999px; padding:2px 9px; font-size:12px; cursor:pointer; font-family:inherit; }
  .tag-opt:hover { border-color:var(--accent-border); color:var(--accent-strong); }
  .tag-opt.on { background:var(--accent-soft); border-color:var(--accent); color:var(--accent-strong); font-weight:500; }
  .status-badge { display:inline-flex; align-items:center; gap:5px; border-radius:999px; padding:2px 9px; font-size:11px; font-weight:550; }
  .status-badge .dot { width:5px; height:5px; border-radius:50%; background:currentColor; }
  .status-badge.pending { background:var(--warn-soft); color:var(--warn); }
  .status-badge.pending .dot { animation:pulse 1.6s var(--spring) infinite; }
  .status-badge.success { background:var(--success-soft); color:var(--success); }
  .status-badge.failure { background:var(--danger-soft); color:var(--danger); }
  .bm-actions { display:flex; gap:2px; flex:none; }
  .bm-actions .ic-btn {
    width:30px; height:30px; display:flex; align-items:center; justify-content:center;
    border:none; border-radius:8px; background:transparent; color:var(--text-3); cursor:pointer;
    transition:background .15s, color .15s, transform .1s var(--spring);
  }
  .bm-actions .ic-btn:hover { background:var(--bg); color:var(--text); }
  .bm-actions .ic-btn:active { transform:scale(.92); }
  .bm-actions .ic-btn.fav.on { color:var(--accent); }
  .bm-actions .ic-btn.fav.on:hover { background:var(--accent-soft); }
  .bm-actions .ic-btn.del:hover { background:var(--danger-soft); color:var(--danger); }
  @media (min-width:768px) { .bm-actions { opacity:0; transition:opacity .18s; } .bookmark-card:hover .bm-actions { opacity:1; } }

  .bm-detail {
    margin-top:14px; padding:16px; border-radius:12px;
    background:var(--surface-2); border:1px solid var(--border);
    display:flex; flex-direction:column; gap:12px;
    animation:rise .22s var(--spring);
  }
  @keyframes rise { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
  .bm-detail .d-item h4 { font-size:11px; font-weight:600; color:var(--text-3); letter-spacing:.05em; text-transform:uppercase; margin-bottom:5px; }
  .bm-detail .d-item .txt { font-size:13.5px; color:var(--text-2); white-space:pre-wrap; word-break:break-word; line-height:1.65; }
  .bm-detail .d-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .confirm-bar { display:flex; align-items:center; gap:8px; background:var(--danger-soft); border:1px solid rgba(220,38,38,.3); border-radius:10px; padding:8px 12px; font-size:13px; color:var(--danger); margin-top:10px; animation:rise .2s var(--spring); }

  /* 工具栏 */
  .toolbar { display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap; align-items:center; }
  .search-box { position:relative; flex:1; min-width:180px; display:flex; align-items:center; }
  .search-box .ic { position:absolute; left:11px; color:var(--text-3); }
  .search-box input {
    width:100%; padding:9px 12px 9px 36px; border:1px solid var(--border-strong); border-radius:10px;
    font-size:14px; background:var(--surface); color:var(--text); font-family:inherit;
    transition:border-color .15s var(--spring), box-shadow .15s var(--spring);
  }
  .search-box input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(234,88,12,.12); }
  .filter-group { display:flex; gap:2px; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:3px; }
  .sort-group { display:flex; gap:2px; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:3px; }
  .sort-btn { border:none; background:transparent; color:var(--text-3); font-size:12.5px; padding:5px 10px; border-radius:7px; cursor:pointer; font-family:inherit; transition:background .15s, color .15s; }
  .sort-btn:hover { color:var(--text); }
  .sort-btn.active { background:var(--accent-soft); color:var(--accent-strong); font-weight:600; }
  .filter-btn {
    padding:5px 12px; font-size:12.5px; border:none; border-radius:8px; cursor:pointer;
    background:transparent; color:var(--text-3); font-weight:500; font-family:inherit;
    transition:background .15s, color .15s;
  }
  .filter-btn:hover { color:var(--text); }
  .filter-btn.active { background:var(--accent-soft); color:var(--accent-strong); font-weight:600; }
  .tag-filter { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:16px; }
  .tag-chip {
    display:inline-flex; align-items:center; gap:5px; background:var(--surface);
    border:1px solid var(--border); border-radius:999px; padding:3px 11px; font-size:12px;
    color:var(--text-2); cursor:pointer; font-family:inherit;
    transition:border-color .15s, color .15s, background .15s;
  }
  .tag-chip:hover { border-color:var(--accent-border); color:var(--accent-strong); }
  .tag-chip.active { background:var(--accent-soft); border-color:var(--accent); color:var(--accent-strong); font-weight:550; }
  .tag-chip .cnt { font-size:10.5px; color:var(--text-3); font-variant-numeric:tabular-nums; }
  .tag-chip.active .cnt { color:var(--accent-strong); opacity:.7; }
  .tag-filter.expanded { max-height:240px; overflow-y:auto; padding-right:4px; }
  .tag-chip.tag-more { color:var(--accent-strong); border-style:dashed; }

  /* 分页 / 空态 / 骨架 */
  .pagination { display:flex; align-items:center; justify-content:center; gap:12px; margin-top:18px; flex-wrap:wrap; }
  .page-info { font-size:12.5px; color:var(--text-3); font-variant-numeric:tabular-nums; }
  .page-jump-wrap { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; color:var(--text-3); }
  .page-jump { width:64px; height:26px; padding:0 8px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text); font-size:12.5px; font-family:inherit; }
  .empty {
    color:var(--text-3); text-align:center; padding:52px 20px; font-size:14px;
    background:var(--surface); border:1px dashed var(--border-strong); border-radius:var(--radius-lg);
  }
  .empty .empty-ic { width:40px; height:40px; margin:0 auto 12px; color:var(--text-3); opacity:.55; }
  .empty .empty-t { font-weight:550; color:var(--text-2); margin-bottom:4px; }
  .skeleton { border-radius:10px; background:linear-gradient(90deg,var(--bg) 25%,var(--bg-deep) 50%,var(--bg) 75%); background-size:200% 100%; animation:shimmer 1.5s infinite; }
  @keyframes shimmer { 0% { background-position:200% 0; } 100% { background-position:-200% 0; } }
  .skeleton-card { height:88px; margin-bottom:12px; border-radius:var(--radius-lg); }
  .load-fail { text-align:center; padding:36px 16px; color:var(--danger); font-size:14px; background:var(--surface); border:1px dashed var(--border-strong); border-radius:var(--radius-lg); }

  /* ============ 设置视图 ============ */
  .settings-grid { display:grid; gap:22px; grid-template-columns:1fr; }
  @media (min-width:900px) { .settings-grid { grid-template-columns:5fr 7fr; align-items:start; } }
  .panel {
    background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
    padding:20px; box-shadow:var(--shadow-xs);
  }
  .panel > h3 { font-size:14px; font-weight:600; letter-spacing:-.01em; margin-bottom:6px; }
  .panel > .p-desc { font-size:12.5px; color:var(--text-3); margin-bottom:16px; }
  .panel .field { margin-bottom:12px; }
  .panel .field > input { padding:9px 12px; border-radius:10px; }
  .mtn-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:8px; }
  @media (max-width:640px) { .mtn-grid { grid-template-columns:1fr; } }
  .mtn-grid .btn { position:relative; }
  .mtn-count {
    display:inline-flex; align-items:center; justify-content:center; min-width:18px; height:18px;
    padding:0 5px; margin-left:6px; border-radius:999px; font-size:11px; font-weight:600;
    background:var(--danger-soft); color:var(--danger);
  }
  .mtn-grid .btn:disabled { opacity:.5; cursor:not-allowed; }
  .job-list { display:flex; flex-direction:column; }
  .job {
    display:flex; align-items:center; gap:12px; padding:12px 0;
    border-bottom:1px solid var(--border);
  }
  .job:last-child { border-bottom:none; padding-bottom:0; }
  .job .j-state { width:34px; height:34px; border-radius:9px; flex:none; display:flex; align-items:center; justify-content:center; }
  .job .j-state.ok { background:var(--success-soft); color:var(--success); }
  .job .j-state.fail { background:var(--danger-soft); color:var(--danger); }
  .job .j-state.run { background:var(--accent-soft); color:var(--accent-strong); }
  .job .j-state.run .ic { animation:spin 2.4s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .job .j-body { flex:1; min-width:0; }
  .job .j-src { font-size:13px; font-weight:550; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .job .j-desc { font-size:12px; color:var(--text-3); margin-top:2px; }
  .job .j-actions { display:flex; gap:6px; flex:none; }

  .provider-item { border:1px solid var(--border); border-radius:14px; padding:16px; margin-bottom:12px; background:var(--surface); }
  .provider-item.open { border-color:var(--accent-border); }
  .provider-item .p-head { display:flex; align-items:center; gap:12px; }
  .provider-item .p-icon { width:36px; height:36px; border-radius:10px; flex:none; display:flex; align-items:center; justify-content:center; background:var(--surface-2); border:1px solid var(--border); color:var(--text-2); }
  .provider-item .p-name { font-size:14px; font-weight:600; }
  .provider-item .p-desc { font-size:12px; color:var(--text-3); margin-top:1px; }
  .provider-item .p-badge { margin-left:auto; font-size:11.5px; font-weight:550; padding:2px 9px; border-radius:999px; }
  .provider-item .p-badge.ok { background:var(--success-soft); color:var(--success); }
  .provider-item .p-badge.no { background:var(--bg); color:var(--text-3); }
  .provider-item .edit-form { display:none; margin-top:14px; padding-top:14px; border-top:1px solid var(--border); }
  .provider-item.open .edit-form { display:block; animation:rise .2s var(--spring); }
  .edit-form .e-row { display:grid; grid-template-columns:1fr; gap:12px; }
  @media (min-width:560px) { .edit-form .e-row { grid-template-columns:1fr 1fr; } }
  .edit-form .e-line { display:flex; gap:8px; align-items:center; margin-top:12px; flex-wrap:wrap; }
  .edit-form .e-line select { flex:1; min-width:150px; }
  select {
    appearance:none; -webkit-appearance:none;
    width:100%; padding:9px 32px 9px 12px;
    border:1px solid var(--border-strong); border-radius:10px; font-size:13.5px;
    background:var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23a8a29e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 10px center;
    color:var(--text); font-family:inherit; cursor:pointer;
    transition:border-color .15s var(--spring), box-shadow .15s var(--spring);
  }
  select:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(234,88,12,.12); }
  select:disabled { opacity:.55; cursor:not-allowed; }
  .e-status { font-size:12px; color:var(--text-3); }
  .e-status.ok { color:var(--success); }
  .e-status.no { color:var(--danger); }
  .edit-form .err { font-size:12.5px; }

  /* ============ 账户视图 ============ */
  .account-grid { display:grid; gap:22px; grid-template-columns:1fr; }
  @media (min-width:900px) { .account-grid { grid-template-columns:6fr 6fr; align-items:start; } }
  .profile-hero {
    display:flex; align-items:center; gap:16px; padding:24px;
    background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
    margin-bottom:22px; box-shadow:var(--shadow-xs);
  }
  .profile-hero .avatar-lg {
    width:56px; height:56px; border-radius:16px; flex:none;
    background:linear-gradient(150deg,var(--accent-soft),var(--accent-border));
    color:var(--accent-strong); display:flex; align-items:center; justify-content:center;
    font-size:22px; font-weight:700;
  }
  .profile-hero .ph-name { font-size:18px; font-weight:650; letter-spacing:-.02em; }
  .profile-hero .ph-mail { font-size:13px; color:var(--text-3); margin-top:2px; word-break:break-all; }
  .profile-hero .ph-tag { margin-left:auto; }
  .kv-row { display:flex; align-items:center; justify-content:space-between; padding:13px 0; border-bottom:1px solid var(--border); }
  .kv-row:last-child { border-bottom:none; }
  .kv-row .k { font-size:13.5px; color:var(--text-2); }
  .kv-row .v { font-size:13.5px; font-weight:550; display:flex; align-items:center; gap:7px; }
  .pill { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:550; padding:2px 10px; border-radius:999px; }
  .pill.on { background:var(--success-soft); color:var(--success); }
  .pill.off { background:var(--bg); color:var(--text-3); }

  /* ============ 移动端底部导航 ============ */
  .tabbar {
    position:fixed; bottom:0; left:0; right:0; z-index:40;
    display:flex; justify-content:space-around; align-items:stretch;
    background:rgba(250,250,249,.92); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);
    border-top:1px solid var(--border);
    padding:4px 6px calc(6px + env(safe-area-inset-bottom));
  }
  .tabbar .tb-item {
    flex:1; display:flex; flex-direction:column; align-items:center; gap:3px;
    padding:7px 4px 5px; border:none; background:transparent; cursor:pointer;
    font-size:10.5px; font-weight:550; color:var(--text-3); font-family:inherit;
    border-radius:10px; transition:color .15s, background .15s;
  }
  .tabbar .tb-item .ic { width:21px; height:21px; transition:transform .25s var(--spring); }
  .tabbar .tb-item.active { color:var(--accent-strong); }
  .tabbar .tb-item:active { background:var(--bg); }
  .tabbar .tb-item.active .ic { transform:translateY(-1px); }
  @media (min-width:768px) { .tabbar { display:none; } }

  /* ============ Toast ============ */
  .toast {
    position:fixed; bottom:calc(84px + env(safe-area-inset-bottom)); left:50%; transform:translateX(-50%) translateY(8px);
    background:#1c1917; color:#fafaf9; padding:10px 18px; border-radius:11px; font-size:13px;
    box-shadow:var(--shadow-md); opacity:0; pointer-events:none; z-index:100;
    transition:opacity .22s var(--spring), transform .22s var(--spring);
  }
  .toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  .toast.error { background:var(--danger); }
  @media (min-width:768px) { .toast { bottom:28px; } }

  @media (prefers-reduced-motion:reduce) {
    *, *::before, *::after { animation-duration:.01ms !important; transition-duration:.01ms !important; }
  }
</style>
</head>
<body>

<!-- 认证页 -->
<div id="auth-view" class="auth-wrap hidden">
  <aside class="auth-aside">
    <div class="brand-lg">
      <span class="mark">
        <svg class="ic" viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/><circle cx="12" cy="12" r="3.2"/></svg>
      </span>
      <span>KaraClone</span>
    </div>
    <blockquote>
      <p>书签、标签、AI 摘要——一处收纳，随时可读。</p>
      <footer>你的私藏书签库，由 Cloudflare 驱动。</footer>
    </blockquote>
    <div style="font-size:12px;color:rgba(250,250,249,.4);position:relative;z-index:1">KaraClone · Phase 0</div>
  </aside>
  <main class="auth-main">
    <div class="auth-box">
      <div class="auth-brand">
        <span class="mark">
          <svg class="ic" viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/><circle cx="12" cy="12" r="3.2"/></svg>
        </span>
        <span>KaraClone</span>
      </div>
      <div id="auth-login-view">
        <h2>欢迎回来</h2>
        <p class="sub">登录以继续管理你的书签</p>
        <form id="login-form" class="form-block">
          <div class="field">
            <label for="login-email">邮箱</label>
            <input id="login-email" type="email" autocomplete="email" required>
          </div>
          <div class="field">
            <label for="login-password">密码</label>
            <input id="login-password" type="password" autocomplete="current-password" required>
          </div>
          <button type="submit" id="login-submit" class="btn block">登录</button>
          <div class="error" id="login-error"></div>
        </form>
        <p class="auth-foot">还没有账号？<a id="to-signup">创建账号</a></p>
      </div>
      <div id="auth-signup-view" class="hidden">
        <h2>创建账号</h2>
        <p class="sub">注册后即可开始保存书签</p>
        <form id="signup-form" class="form-block">
          <div class="field">
            <label for="signup-name">昵称</label>
            <input id="signup-name" type="text" required>
          </div>
          <div class="field">
            <label for="signup-email">邮箱</label>
            <input id="signup-email" type="email" autocomplete="email" required>
          </div>
          <div class="field">
            <label for="signup-password">密码（至少 8 位）</label>
            <input id="signup-password" type="password" autocomplete="new-password" required>
          </div>
          <div class="field">
            <label for="signup-confirm">确认密码</label>
            <input id="signup-confirm" type="password" autocomplete="new-password" required>
          </div>
          <button type="submit" id="signup-submit" class="btn block">注册</button>
          <div class="error" id="signup-error"></div>
        </form>
        <p class="auth-foot">已有账号？<a id="to-login">直接登录</a></p>
      </div>
    </div>
  </main>
</div>

<!-- 主应用 -->
<div id="app-view" class="app hidden">
  <!-- 桌面侧栏 -->
  <aside class="sidebar">
    <div class="brand">
      <span class="mark">
        <svg class="ic" viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/><circle cx="12" cy="12" r="3.2"/></svg>
      </span>
      <span class="bn">KaraClone</span>
    </div>
    <nav class="nav-group">
      <div class="nav-group-label">书签库</div>
      <button class="nav-item active" data-nav="bookmarks">
        <svg class="ic" viewBox="0 0 24 24"><path d="M6 3.5h12A1.5 1.5 0 0 1 19.5 5v16l-4.2-2.6L12 20l-3.3-1.6L4.5 21V5A1.5 1.5 0 0 1 6 3.5Z"/></svg>
        <span>书签</span>
        <span class="nav-badge" id="nav-bm-count"></span>
      </button>
      <button class="nav-item" data-nav="settings">
        <svg class="ic" viewBox="0 0 24 24"><path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z"/><path d="M19.2 14.5a1.6 1.6 0 0 0 .32 1.77l.06.06a1.9 1.9 0 1 1-2.68 2.68l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.46V20.4a1.9 1.9 0 1 1-3.79 0v-.08a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a1.9 1.9 0 1 1-2.68-2.68l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.46-.97H3.6a1.9 1.9 0 1 1 0-3.79h.08a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.9 1.9 0 1 1 2.68-2.68l.06.06a1.6 1.6 0 0 0 1.77.32h.08a1.6 1.6 0 0 0 .97-1.46V3.6a1.9 1.9 0 1 1 3.79 0v.08a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.9 1.9 0 1 1 2.68 2.68l-.06.06a1.6 1.6 0 0 0-.32 1.77v.08a1.6 1.6 0 0 0 1.46.97h.08a1.9 1.9 0 1 1 0 3.79h-.08a1.6 1.6 0 0 0-1.46.97Z"/></svg>
        <span>设置</span>
      </button>
    </nav>
    <nav class="nav-group">
      <div class="nav-group-label">账户</div>
      <button class="nav-item" data-nav="account">
        <svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="8.4" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/></svg>
        <span>账户信息</span>
      </button>
    </nav>
    <div class="sidebar-foot">
      <div class="user-row" id="user-row" role="button" title="账户信息">
        <div class="avatar" id="user-avatar"><span class="dot"></span></div>
        <div style="min-width:0">
          <div class="u-name" id="user-name"></div>
          <div class="u-mail" id="user-mail"></div>
        </div>
      </div>
      <div class="ver" id="app-version">v__SERVER_VERSION__</div>
    </div>
  </aside>

  <!-- 内容 -->
  <div class="main">
    <div class="topbar">
      <div class="page-title" id="page-title">书签</div>
      <button id="logout-btn" class="btn ghost sm">登出</button>
    </div>
    <div class="content">

      <!-- 书签视图（主页） -->
      <section id="bookmarks-view">
        <div class="section-head">
          <h2>书签</h2>
          <span class="count-lbl" id="bm-count-lbl"></span>
        </div>
        <div class="quick-save">
          <div class="qs-head">
            <svg class="ic" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <h3>保存书签</h3>
          </div>
          <form id="save-form" class="qs-form">
            <div class="qs-row">
              <div class="field">
                <label for="save-url">URL</label>
                <input id="save-url" type="url" placeholder="https://example.com" required>
              </div>
              <div class="field">
                <label for="save-title">标题（可选）</label>
                <input id="save-title" type="text" placeholder="页面标题">
              </div>
            </div>
            <div class="field">
              <label for="save-note">笔记（可选）</label>
              <textarea id="save-note" rows="2" placeholder="添加备注…"></textarea>
            </div>
            <div class="qs-submit-row">
              <button type="submit" id="save-submit" class="btn">保存</button>
              <div class="error" id="save-error"></div>
            </div>
          </form>
        </div>
        <div class="toolbar">
          <div class="search-box">
            <svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><line x1="16" y1="16" x2="20.5" y2="20.5"/></svg>
            <input id="search-input" type="text" placeholder="搜索标题 / URL…">
          </div>
          <div class="filter-group" id="filter-group">
            <button class="filter-btn active" data-filter="all">全部</button>
            <button class="filter-btn" data-filter="fav">收藏</button>
            <button class="filter-btn" data-filter="archived">归档</button>
          </div>
          <div class="sort-group" id="sort-group">
            <button class="sort-btn active" data-sort="desc">最新</button>
            <button class="sort-btn" data-sort="asc">最旧</button>
          </div>
          <button class="btn secondary sm hidden" id="export-urls" title="把当前列表里的 URL 导出为 txt（一行一个）">导出 URL</button>
        </div>
        <div class="tag-filter" id="tag-filter"></div>
        <div id="bookmark-list"></div>
        <div class="pagination hidden" id="pagination">
          <button class="btn secondary sm" id="prev-page">上一页</button>
          <span class="page-info" id="page-info"></span>
          <button class="btn secondary sm" id="next-page">下一页</button>
          <span class="page-jump-wrap">跳至 <input id="page-jump" class="page-jump" type="number" min="1" value="1"> 页 <button class="btn secondary sm" id="page-jump-go">跳转</button></span>
        </div>
      </section>

      <!-- 设置视图 -->
      <section id="settings-view" class="hidden">
        <div class="section-head">
          <h2>设置</h2>
          <span class="count-lbl">导入与 AI 配置</span>
        </div>
        <div class="settings-grid">
          <div class="panel">
            <h3>数据导入</h3>
            <p class="p-desc">从其他 Karakeep 实例导入书签与标签（按 URL 去重，最多 500 条），后台执行。</p>
            <form id="import-form">
              <div class="field">
                <label for="import-url">源服务器地址</label>
                <input id="import-url" type="url" placeholder="https://karakeep.example.com" required>
              </div>
              <div class="field">
                <label for="import-email">邮箱</label>
                <input id="import-email" type="email" autocomplete="off" required>
              </div>
              <div class="field">
                <label for="import-password">密码</label>
                <input id="import-password" type="password" autocomplete="off" required>
              </div>
              <button type="submit" id="import-submit" class="btn block">开始导入</button>
              <div class="error" id="import-error" style="margin-top:8px"></div>
            </form>
            <h3 style="font-size:13px;margin:20px 0 10px">维护任务</h3>
            <p class="p-desc" style="margin-bottom:10px">后台执行的维护操作，历史与状态见下方任务列表。</p>
            <div class="mtn-grid">
              <button type="button" class="btn secondary" data-mtn="import">导入原版数据</button>
              <button type="button" class="btn secondary" data-mtn="retag">重新统计标签</button>
              <button type="button" class="btn secondary" data-mtn="translate">翻译标签</button>
              <button type="button" class="btn secondary" data-mtn="retry-tagging" id="mtn-retry-tagging" disabled>
                重试失败标签<span class="mtn-count hidden" id="mtn-retry-count">0</span>
              </button>
            </div>
            <p class="p-desc" id="mtn-retry-hint" style="margin-top:8px">打标签失败的书签会重新入队，并用当前保存的模型重跑。</p>
            <h3 style="font-size:13px;margin:20px 0 10px">任务历史</h3>
            <div class="job-list" id="import-jobs"></div>
          </div>
          <div>
            <div class="panel" style="margin-bottom:20px">
              <h3>AI 提供商</h3>
              <p class="p-desc">配置对话与向量模型提供商</p>
              <div id="provider-list"></div>
            </div>
            <div class="panel">
              <h3>模型选择</h3>
              <p class="p-desc">打标签 / 摘要使用的模型。改选后立即保存，对之后入队的任务生效。</p>
              <div class="field">
                <label for="chat-model-select">对话模型（LLM）</label>
                <select id="chat-model-select"><option value="">先配置并拉取模型</option></select>
              </div>
              <div class="field">
                <label for="embed-model-select">向量模型（Embedding，可选）</label>
                <select id="embed-model-select"><option value="">不使用向量模型</option></select>
              </div>
              <button type="button" id="save-selection" class="btn block">保存模型选择</button>
              <div class="error" id="llm-error" style="margin-top:8px"></div>
              <div class="muted" id="llm-status" style="margin-top:6px"></div>
            </div>
          </div>
        </div>
      </section>

      <!-- 账户视图 -->
      <section id="account-view" class="hidden">
        <div class="section-head">
          <h2>账户信息</h2>
          <span class="count-lbl">个人资料与偏好</span>
        </div>
        <div class="profile-hero" id="profile-hero"></div>
        <div class="account-grid">
          <div class="panel">
            <h3>个人资料</h3>
            <p class="p-desc">当前登录账户的基础信息</p>
            <div class="kv-row"><span class="k">昵称</span><span class="v" id="acc-name"></span></div>
            <div class="kv-row"><span class="k">邮箱</span><span class="v" id="acc-email"></span></div>
            <div class="kv-row"><span class="k">账户 ID</span><span class="v mono" id="acc-id" style="font-size:12px;color:var(--text-3)"></span></div>
          </div>
          <div class="panel">
            <h3>偏好</h3>
            <p class="p-desc">阅读与行为设置</p>
            <div class="kv-row"><span class="k">点击书签</span><span class="v" id="acc-click"></span></div>
            <div class="kv-row"><span class="k">归档显示</span><span class="v" id="acc-archive"></span></div>
            <div class="kv-row"><span class="k">时区</span><span class="v" id="acc-tz"></span></div>
            <div class="kv-row"><span class="k">自动备份</span><span class="v"><span class="pill off" id="acc-backup">未启用</span></span></div>
          </div>
          <div class="panel" style="margin-top:22px;border-color:rgba(220,38,38,.25)">
            <h3>会话</h3>
            <p class="p-desc">登出当前设备</p>
            <button type="button" id="logout-btn-acc" class="btn danger-ghost">登出</button>
          </div>
        </div>
      </section>

    </div>
  </div>
</div>

<!-- 移动端底部导航 -->
<nav class="tabbar hidden" id="tabbar">
  <button class="tb-item active" data-nav="bookmarks">
    <svg class="ic" viewBox="0 0 24 24"><path d="M6 3.5h12A1.5 1.5 0 0 1 19.5 5v16l-4.2-2.6L12 20l-3.3-1.6L4.5 21V5A1.5 1.5 0 0 1 6 3.5Z"/></svg>
    <span>书签</span>
  </button>
  <button class="tb-item" data-nav="settings">
    <svg class="ic" viewBox="0 0 24 24"><path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 1 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 1 1-2.83-2.83l.05-.05a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 1 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 1 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.55 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1.03Z"/></svg>
    <span>设置</span>
  </button>
  <button class="tb-item" data-nav="account">
    <svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="8.4" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/></svg>
    <span>我的</span>
  </button>
</nav>

<div class="toast" id="toast"></div>

<script>
(function () {
  var base = location.origin;
  var apiKey = localStorage.getItem("karaclone_api_key") || "";
  var user = null;

  // ---- superjson（仅 Date）----
  function deserializeSuperjson(payload) {
    if (!payload || typeof payload !== "object" || !("json" in payload)) return payload;
    var json = payload.json, meta = payload.meta;
    if (!meta || !meta.values) return json;
    var values = meta.values;
    if (Array.isArray(values)) {
      var i = 0;
      function walkArr(v) {
        if (values[i] === "Date") { i++; return new Date(v); }
        if (Array.isArray(v)) return v.map(walkArr);
        if (v && typeof v === "object") {
          var o = {};
          Object.keys(v).forEach(function (k) { o[k] = walkArr(v[k]); });
          return o;
        }
        return v;
      }
      return walkArr(json);
    }
    // 对象形式：路径 → 类型数组（如 {"bookmarks.0.createdAt": ["Date"]}）
    function getPath(obj, path) {
      var cur = obj;
      var parts = path.split(".");
      for (var i = 0; i < parts.length; i++) {
        if (cur == null) return undefined;
        cur = cur[parts[i]];
      }
      return cur;
    }
    function setPath(obj, path, val) {
      var cur = obj;
      var parts = path.split(".");
      for (var i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = val;
    }
    Object.keys(values).forEach(function (path) {
      var types = values[path];
      var val = getPath(json, path);
      if (val === undefined) return;
      if (types.indexOf("Date") !== -1) setPath(json, path, new Date(val));
    });
    return json;
  }

  // ---- superjson 序列化（仅 Date，对象形式 meta）----
  function serializeSuperjson(input) {
    var values = {};
    function walk(v, path) {
      if (v instanceof Date) { values[path] = ["Date"]; return v.toISOString(); }
      if (Array.isArray(v)) return v.map(function (x, i) { return walk(x, path + "." + i); });
      if (v && typeof v === "object") {
        var o = {};
        Object.keys(v).forEach(function (k) { o[k] = walk(v[k], path ? path + "." + k : k); });
        return o;
      }
      return v;
    }
    var json = walk(input, "");
    var keys = Object.keys(values);
    return keys.length ? { json: json, meta: { values: values } } : { json: json };
  }

  // ---- tRPC 客户端 ----
  async function trpc(path, input, method) {
    var headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    var url = base + "/api/trpc/" + path + "?batch=1";
    var body;
    if (method === "GET") {
      url += "&input=" + encodeURIComponent(JSON.stringify({ "0": serializeSuperjson(input || {}) }));
    } else {
      body = JSON.stringify({ "0": serializeSuperjson(input || {}) });
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
    return deserializeSuperjson(item.result.data);
  }

  // ---- 工具 ----
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDate(d) {
    if (!d) return "";
    var dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return "";
    var now = new Date();
    var diff = now - dt;
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 3600 * 1000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 24 * 3600 * 1000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 7 * 24 * 3600 * 1000) return Math.floor(diff / 86400000) + " 天前";
    return dt.toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
  }
  function faviconUrl(url) {
    try { return "https://www.google.com/s2/favicons?domain=" + encodeURIComponent(new URL(url).hostname) + "&sz=32"; }
    catch (e) { return ""; }
  }
  var toastTimer = null;
  function toast(msg, isError) {
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, 2600);
  }

  // ---- 视图切换（三视图 + 侧栏/底部导航同步） ----
  var VIEW_TITLES = { bookmarks: "书签", settings: "设置", account: "账户信息" };
  function switchView(name) {
    ["bookmarks", "settings", "account"].forEach(function (v) {
      document.getElementById(v + "-view").classList.toggle("hidden", v !== name);
    });
    document.querySelectorAll("[data-nav]").forEach(function (el) {
      el.classList.toggle("active", el.dataset.nav === name);
    });
    document.getElementById("page-title").textContent = VIEW_TITLES[name] || "书签";
    if (name === "bookmarks") { startAutoRefresh(); }
    else { stopAutoRefresh(); }
    if (name === "settings") { loadLlmConfig(); loadImportJobs(); loadFailedTaggingCount(); startImportPolling(); }
    else if (name === "account") { loadAccount(); }
  }
  document.querySelectorAll("[data-nav]").forEach(function (el) {
    el.addEventListener("click", function () { switchView(el.dataset.nav); });
  });

  // ---- 认证可见性 ----
  function showAuth() {
    document.getElementById("auth-view").classList.remove("hidden");
    document.getElementById("app-view").classList.add("hidden");
    document.getElementById("tabbar").classList.add("hidden");
  }
  function showApp() {
    document.getElementById("auth-view").classList.add("hidden");
    document.getElementById("app-view").classList.remove("hidden");
    document.getElementById("tabbar").classList.remove("hidden");
  }

  // ---- 登录 / 注册切换 ----
  function authSwitch(toLogin) {
    document.getElementById("auth-login-view").classList.toggle("hidden", !toLogin);
    document.getElementById("auth-signup-view").classList.toggle("hidden", toLogin);
  }
  document.getElementById("to-signup").addEventListener("click", function () { authSwitch(false); });
  document.getElementById("to-login").addEventListener("click", function () { authSwitch(true); });

  document.getElementById("login-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var errEl = document.getElementById("login-error");
    var btn = document.getElementById("login-submit");
    errEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "登录中…";
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
    } finally {
      btn.disabled = false;
      btn.textContent = "登录";
    }
  });

  document.getElementById("signup-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var errEl = document.getElementById("signup-error");
    var btn = document.getElementById("signup-submit");
    errEl.textContent = "";
    var password = document.getElementById("signup-password").value;
    var confirm = document.getElementById("signup-confirm").value;
    if (password !== confirm) { errEl.textContent = "两次密码不一致"; return; }
    btn.disabled = true;
    btn.textContent = "注册中…";
    try {
      await trpc("users.create", {
        name: document.getElementById("signup-name").value.trim(),
        email: document.getElementById("signup-email").value.trim(),
        password: password,
        confirmPassword: confirm
      });
      authSwitch(true);
      document.getElementById("login-email").value = document.getElementById("signup-email").value.trim();
      document.getElementById("login-password").value = "";
      var okEl = document.getElementById("login-error");
      okEl.textContent = "注册成功，请登录";
      okEl.style.color = "var(--success)";
    } catch (err) {
      errEl.textContent = err.message || "注册失败";
    } finally {
      btn.disabled = false;
      btn.textContent = "注册";
    }
  });

  document.getElementById("user-row").addEventListener("click", function () { switchView("account"); });

  document.querySelectorAll("#logout-btn, #logout-btn-acc").forEach(function (el) {
    if (!el) return;
    el.addEventListener("click", function () {
      apiKey = "";
      localStorage.removeItem("karaclone_api_key");
      showAuth();
      toast("已登出");
    });
  });

  // ---- 书签状态 ----
  var PAGE_SIZE = 20;
  var TAG_COLLAPSED = 60;

  var state = {
    filter: "all",          // all | fav | archived
    sortOrder: "desc",      // desc 最新 | asc 最旧
    tagId: null,
    search: "",
    offset: 0,              // 当前页起始偏移（offset 分页）
    total: 0,               // 当前过滤条件下的总条数
    hasMore: false,
    expandedId: null,
    confirmDeleteId: null,
    tagEditId: null,
    bmCache: {},
    allTags: null,          // 标签编辑弹窗的候选标签（loadTagCandidates）
    tagFilterTags: null,    // 标签筛选栏的标签
    tagFilterTotal: 0,      // 标签总数（用于「展开全部」）
    tagFilterLoadedAll: false, // 是否已把全部分页拉完
    tagFilterLoadFailed: false, // 上次全量拉取是否失败（用于按钮文案与重试）
    tagFilterExpanded: false,  // 当前是否处于展开态（与「已加载全部」是两件事）
    refreshTimer: null
  };

  // ---- 书签列表 ----
  function buildQuery() {
    var q = { limit: PAGE_SIZE, includeContent: false, sortOrder: state.sortOrder, offset: state.offset };
    if (state.filter === "fav") q.favourited = true;
    if (state.filter === "archived") q.archived = true;
    if (state.tagId) q.tagId = state.tagId;
    if (state.search) q.q = state.search;
    return q;
  }

  function renderSkeleton() {
    var html = "";
    for (var i = 0; i < 4; i++) html += '<div class="skeleton skeleton-card"></div>';
    document.getElementById("bookmark-list").innerHTML = html;
  }

  function statusBadgeHtml(bm) {
    if (bm.taggingStatus === "pending") return '<span class="status-badge pending"><span class="dot"></span>标签生成中</span>';
    if (bm.taggingStatus === "failure") {
      return '<span class="status-badge failure"><span class="dot"></span>标签失败</span>' +
        '<button type="button" class="btn secondary sm" data-act="retry-tagging" data-id="' + bm.id + '" ' +
        'title="用当前保存的模型重新生成标签" style="height:20px;padding:0 8px;font-size:11px">重试</button>';
    }
    if (bm.taggingStatus === "success") return '<span class="status-badge success"><span class="dot"></span>已生成</span>';
    return "";
  }

  function renderEmpty() {
    var listEl = document.getElementById("bookmark-list");
    var msgs = {
      all: ["还没有书签", "保存第一个书签，开启你的书签库"],
      fav: ["没有收藏", "点书签右侧的星标即可收藏"],
      archived: ["没有归档", "归档的书签会出现在这里"]
    };
    var m = msgs[state.filter] || msgs.all;
    listEl.innerHTML =
      '<div class="empty">' +
        '<svg class="ic empty-ic" viewBox="0 0 24 24"><path d="M20 8.5 12 2 4 8.5v13h16v-13ZM8.8 14.4l2.1 2.1 4.2-4.3"/></svg>' +
        '<div class="empty-t">' + m[0] + "</div>" +
        "<div>" + m[1] + "</div>" +
      "</div>";
  }

  function cardHtml(bm) {
      var content = bm.content || {};
      var url = content.url || bm.url || "";
      var title = bm.title || content.title || url || "(无标题)";
      var favicon = url ? faviconUrl(url) : "";
      var tags = (bm.tags || []).map(function (t) {
        return '<span class="chip" data-act="edit-tags" data-id="' + bm.id + '" title="编辑标签">' + esc(t.name) + '<svg class="ic-edit" viewBox="0 0 24 24"><path d="M4 20l4.5-1 10-10-3.5-3.5-10 10L4 20Z"/><path d="M13.5 6.5l3.5 3.5"/></svg></span>';
      }).join("");
      var tagEditBtn = '<button class="chip" data-act="edit-tags" data-id="' + bm.id + '" title="编辑标签" style="border-style:dashed;opacity:.75">+ 标签</button>';
      var tagEditorHtml = state.tagEditId === bm.id
        ? '<div class="tag-editor" data-tag-editor="' + bm.id + '">' +
            '<div class="te-current">' + (bm.tags || []).map(function (t) {
              return '<span class="chip">' + esc(t.name) + '<button class="chip-x" data-act="tag-remove" data-id="' + bm.id + '" data-tag="' + t.id + '" title="移除">×</button></span>';
            }).join("") + "</div>" +
            '<div class="te-input-row">' +
              '<input class="te-input" data-tag-input="' + bm.id + '" placeholder="新标签名，回车添加" maxlength="60">' +
              '<button class="btn sm" data-act="tag-add" data-id="' + bm.id + '">添加</button>' +
            "</div>" +
            '<div class="te-all" data-tag-all="' + bm.id + '"></div>' +
          "</div>"
        : "";
      var expanded = state.expandedId === bm.id;
      var favOn = bm.favourited ? " on" : "";
      var note = bm.note ? '<div class="d-item"><h4>笔记</h4><p class="txt">' + esc(bm.note) + "</p></div>" : "";
      var summary = bm.summary ? '<div class="d-item"><h4>摘要</h4><p class="txt">' + esc(bm.summary) + "</p></div>" : "";
      var detailHtml = expanded
        ? '<div class="bm-detail">' + note + summary +
          '<div class="d-actions">' +
            (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener"><button class="btn secondary sm">打开原文</button></a>' : "") +
            '<a href="' + base + '/dashboard/preview/' + bm.id + '" target="_blank" rel="noopener"><button class="btn secondary sm">阅读视图</button></a>' +
          "</div></div>"
        : "";
      var confirmHtml = state.confirmDeleteId === bm.id
        ? '<div class="confirm-bar">确认删除这条书签？<button class="btn sm" style="background:var(--danger);color:#fff" data-act="confirm-del" data-id="' + bm.id + '">删除</button><button class="btn ghost sm" data-act="cancel-del">取消</button></div>'
        : "";
      return (
        '<div class="bm-top">' +
          '<div class="bm-favicon">' +
            (favicon ? '<img src="' + esc(favicon) + '" alt="" loading="lazy">' : '<svg class="ic" viewBox="0 0 24 24"><path d="M8 4l8-1v14l-8 1V4Z"/><path d="M14 20l-8 1"/></svg>') +
          "</div>" +
          '<div class="bm-main">' +
            '<div class="bm-title-row">' +
              '<span class="bm-title" data-act="toggle-detail" data-id="' + bm.id + '">' + esc(title) + "</span>" +
              statusBadgeHtml(bm) +
            "</div>" +
            (url ? '<div class="bm-url"><a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url) + "</a></div>" : "") +
            '<div class="bm-meta">' +
              '<span class="bm-date">' + fmtDate(bm.createdAt) + "</span>" +
              (tags ? '<span class="sep"></span>' + tags : "") +
              (tags ? '<span class="sep"></span>' : "") + tagEditBtn +
            "</div>" +
            tagEditorHtml +
            detailHtml +
            confirmHtml +
          "</div>" +
          '<div class="bm-actions">' +
            '<button class="ic-btn fav' + favOn + '" data-act="toggle-fav" data-id="' + bm.id + '" title="' + (bm.favourited ? "取消收藏" : "收藏") + '">' +
              '<svg class="ic-sm" viewBox="0 0 24 24" style="' + (bm.favourited ? "fill:var(--accent)" : "") + '"><path d="M12 3.6 14.6 8l5.4.8-3.9 3.8.9 5.4-4.9-2.6-4.9 2.6.9-5.4L4 8.8 9.4 8 12 3.6Z"/></svg>' +
            "</button>" +
            '<button class="ic-btn arch' + (bm.archived ? " on" : "") + '" data-act="toggle-arch" data-id="' + bm.id + '" title="' + (bm.archived ? "取消归档" : "归档") + '" style="' + (bm.archived ? "color:var(--accent)" : "") + '">' +
              '<svg class="ic-sm" viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="6" x2="4" y2="4h16v2"/><rect x="4" y="6" width="16" height="14" rx="1.5"/><line x1="9" y1="11" x2="15" y2="11"/></svg>' +
            "</button>" +
            '<button class="ic-btn del" data-act="ask-del" data-id="' + bm.id + '" title="删除">' +
              '<svg class="ic-sm" viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>' +
            "</button>" +
          "</div>" +
        "</div>");
  }

  function renderBookmarks(bookmarks) {
    var listEl = document.getElementById("bookmark-list");
    if (!bookmarks.length) { renderEmpty(); return; }
    listEl.innerHTML = "";
    bookmarks.forEach(function (bm) {
      state.bmCache[bm.id] = bm;
      var div = document.createElement("div");
      div.className = "bookmark-card";
      div.setAttribute("data-bm-id", bm.id);
      div.innerHTML = cardHtml(bm);
      listEl.appendChild(div);
    });
  }

  // 局部更新单张卡片（不整列表刷新）
  function patchBookmarkCard(id, patch) {
    var bm = state.bmCache[id];
    var div = document.querySelector('#bookmark-list [data-bm-id="' + id + '"]');
    if (!bm || !div) return false;
    if (patch) Object.assign(bm, patch);
    div.innerHTML = cardHtml(bm);
    return true;
  }

  function removeBookmarkCard(id) {
    var div = document.querySelector('#bookmark-list [data-bm-id="' + id + '"]');
    if (div) div.remove();
    delete state.bmCache[id];
    if (!document.querySelector("#bookmark-list .bookmark-card")) renderEmpty();
  }

  function applyTagChange(bm, attached, detached) {
    bm.tags = bm.tags || [];
    detached.forEach(function (tid) {
      bm.tags = bm.tags.filter(function (t) { return t.id !== tid; });
    });
    attached.forEach(function (t) {
      if (!bm.tags.some(function (x) { return x.id === t.id; })) bm.tags.push(t);
    });
  }

  async function addTagToBookmark(id, name) {
    name = String(name || "").trim().replace(/^#+/, "");
    if (!name) return;
    try {
      var res = await trpc("bookmarks.updateTags", { bookmarkId: id, attach: [{ tagName: name }], detach: [] });
      var bm = state.bmCache[id];
      if (bm) {
        applyTagChange(bm, [{ id: res.attached[0], name: name }], []);
        patchBookmarkCard(id);
      }
      loadTagFilter();
    } catch (err) { toast(err.message || "添加标签失败", true); }
  }

  async function loadTagCandidates(id) {
    try {
      var data = await trpc("tags.list", { limit: 100, sortBy: "name" }, "GET");
      state.allTags = data.tags;
      var el = document.querySelector('[data-tag-all="' + id + '"]');
      if (!el) return;
      var bm = state.bmCache[id];
      var have = new Set((bm && bm.tags || []).map(function (t) { return t.id; }));
      el.innerHTML = state.allTags.map(function (t) {
        return '<button class="tag-opt' + (have.has(t.id) ? " on" : "") + '" data-act="tag-opt-toggle" data-id="' + id + '" data-tag="' + t.id + '">' + esc(t.name) + "</button>";
      }).join("");
    } catch (e) { /* 候选加载失败不阻塞 */ }
  }

  // 拉取当前 offset 的一页。若 offset 越界（例如停在第 3 页时书签被删到只剩 2 页），
  // 收敛到最后一页的起点并重试一次；total 为 0 时把 offset 归零。
  // 收敛只做一次：目标 offset 与当前相同时不再重试，避免递归。
  async function fetchBookmarksPage() {
    var data = await trpc("bookmarks.getBookmarks", buildQuery(), "GET");
    var list = data.bookmarks || [];
    var total = typeof data.total === "number" ? data.total : list.length;
    if (total === 0) {
      state.offset = 0;
    } else if (!list.length && state.offset > 0) {
      var lastOffset = Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE;
      if (lastOffset !== state.offset) {
        state.offset = lastOffset;
        data = await trpc("bookmarks.getBookmarks", buildQuery(), "GET");
        list = data.bookmarks || [];
        total = typeof data.total === "number" ? data.total : list.length;
      }
    }
    state.total = total;
    state.hasMore = state.offset + list.length < state.total;
    return list;
  }

  // keepPage: false = 回到第 1 页；true = 保持当前 offset
  async function loadBookmarks(keepPage) {
    if (!keepPage) state.offset = 0;
    renderSkeleton();
    try {
      var list = await fetchBookmarksPage();
      renderBookmarks(list);
      updateCountLabel();
      updatePagination();
    } catch (err) {
      document.getElementById("bookmark-list").innerHTML =
        '<div class="load-fail">加载失败：' + esc(err.message || "未知错误") + "</div>";
    }
  }

  function updateCountLabel() {
    var el = document.getElementById("bm-count-lbl");
    if (!el) return;
    el.textContent = state.search
      ? "搜索“" + state.search + "”：共 " + state.total + " 条"
      : "共 " + state.total + " 条";
  }

  function updatePagination() {
    var el = document.getElementById("pagination");
    var totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    var page = Math.floor(state.offset / PAGE_SIZE) + 1;
    if (state.total <= PAGE_SIZE) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    document.getElementById("page-info").textContent =
      "第 " + page + " / " + totalPages + " 页 · 共 " + state.total + " 条";
    document.getElementById("prev-page").disabled = page <= 1;
    document.getElementById("next-page").disabled = page >= totalPages;
    var jump = document.getElementById("page-jump");
    if (jump) {
      jump.max = String(totalPages);
      if (document.activeElement !== jump) jump.value = String(page);
    }
  }

  function gotoPage(p) {
    var totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    p = Math.min(Math.max(1, p), totalPages);
    state.offset = (p - 1) * PAGE_SIZE;
    loadBookmarks(true);
  }

  document.getElementById("prev-page").addEventListener("click", function () {
    gotoPage(Math.floor(state.offset / PAGE_SIZE));
  });
  document.getElementById("next-page").addEventListener("click", function () {
    gotoPage(Math.floor(state.offset / PAGE_SIZE) + 2);
  });
  document.getElementById("page-jump-go").addEventListener("click", function () {
    var v = parseInt(document.getElementById("page-jump").value, 10);
    if (isNaN(v)) return;
    gotoPage(v);
  });
  document.getElementById("page-jump").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("page-jump-go").click(); }
  });

  // ---- 筛选 ----
  document.getElementById("filter-group").addEventListener("click", function (e) {
    var btn = e.target.closest(".filter-btn");
    if (!btn) return;
    document.querySelectorAll(".filter-btn").forEach(function (b) { b.classList.remove("active"); });
    btn.classList.add("active");
    state.filter = btn.dataset.filter;
    state.tagId = null;
    document.querySelectorAll(".tag-chip").forEach(function (c) { c.classList.remove("active"); });
    syncExportButton();
    loadBookmarks(false);
  });

  // ---- 排序 ----
  document.getElementById("sort-group").addEventListener("click", function (e) {
    var btn = e.target.closest(".sort-btn");
    if (!btn) return;
    document.querySelectorAll(".sort-btn").forEach(function (b) { b.classList.remove("active"); });
    btn.classList.add("active");
    state.sortOrder = btn.dataset.sort;
    loadBookmarks(false);
  });

  var searchDebounce = null;
  document.getElementById("search-input").addEventListener("input", function (e) {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function () {
      state.search = e.target.value.trim();
      syncExportButton();
      loadBookmarks(false);
    }, 350);
  });

  // ---- 标签筛选 ----
  async function loadTagFilter() {
    try {
      var wasExpanded = state.tagFilterExpanded;
      var data = await trpc("tags.list", { limit: 100, sortBy: "usage" }, "GET");
      state.tagFilterTags = data.tags || [];
      state.tagFilterTotal = typeof data.total === "number" ? data.total : state.tagFilterTags.length;
      state.tagFilterLoadedAll = false;
      state.tagFilterLoadFailed = false;
      if (wasExpanded) {
        var ok = await loadAllTagFilterPages();
        if (!ok) {
          // 全量拉取失败：退回折叠态，保留首屏标签，按钮仍可点以重试
          state.tagFilterLoadFailed = true;
          state.tagFilterExpanded = false;
        }
        renderTagFilter();
        return;
      }
      renderTagFilter();
    } catch (e) { /* 标签加载失败不阻塞 */ }
  }

  // 幂等重建：每次都从 page 0 重新翻完所有分页，累积到局部数组后整体替换。
  // 反复调用不会重复追加（早期版本往 state.tagFilterTags 上 concat，展开→收起→再展开会翻倍）。
  // 任意一页失败或翻页上限用尽都算整体失败：此时不改动 state、不标记已加载全部，
  // 保留此前已渲染的标签，由调用方决定是否重试。返回 true 表示全量拉取成功。
  async function loadAllTagFilterPages() {
    var acc = [];
    var page = 0;
    var guard = 0;
    var complete = false;
    try {
      while (guard++ < 100) {
        var d = await trpc("tags.list", { limit: 100, sortBy: "usage", cursor: { page: page } }, "GET");
        var batch = d.tags || [];
        if (batch.length) acc = acc.concat(batch);
        if (!d.nextCursor) { complete = true; break; }
        page = d.nextCursor.page;
      }
    } catch (e) { /* 任意一页失败都按整体失败处理 */ }
    if (!complete) return false;
    state.tagFilterTags = acc;
    state.tagFilterLoadedAll = true;
    state.tagFilterLoadFailed = false;
    renderTagFilter();
    return true;
  }

  function renderTagFilter() {
    var el = document.getElementById("tag-filter");
    var tags = state.tagFilterTags || [];
    if (!tags.length) {
      el.innerHTML = "";
      el.classList.remove("expanded");
      return;
    }
    var expanded = !!state.tagFilterExpanded;
    var shown = expanded ? tags : tags.slice(0, TAG_COLLAPSED);
    el.innerHTML = shown.map(function (t) {
      return '<button class="tag-chip' + (state.tagId === t.id ? " active" : "") + '" data-tag="' + t.id + '">' +
        esc(t.name) + ' <span class="cnt">' + t.numBookmarks + "</span></button>";
    }).join("");
    if (state.tagFilterTotal > TAG_COLLAPSED) {
      var more = document.createElement("button");
      more.className = "tag-chip tag-more";
      more.id = "tag-filter-more";
      more.textContent = state.tagFilterLoadFailed
        ? "加载失败，点击重试"
        : expanded ? "收起" : "展开全部（共 " + state.tagFilterTotal + " 个标签）";
      more.addEventListener("click", async function () {
        if (state.tagFilterExpanded) {
          // 只收起，已加载的全量数据保留在 state.tagFilterTags 里
          state.tagFilterExpanded = false;
          renderTagFilter();
          return;
        }
        if (!state.tagFilterLoadedAll) {
          more.disabled = true;
          more.textContent = "加载中…";
          var ok = await loadAllTagFilterPages(); // 成功时内部会 render 一次
          if (!ok) {
            // 失败：不进入展开态，保留已渲染的标签，按钮恢复可点以便重试
            state.tagFilterLoadFailed = true;
            state.tagFilterExpanded = false;
            renderTagFilter();
            return;
          }
          state.tagFilterLoadFailed = false;
        }
        // 必须放在 loadAllTagFilterPages 之后，否则中间态会先闪成收起
        state.tagFilterExpanded = true;
        renderTagFilter();
      });
      el.appendChild(more);
    }
    el.classList.toggle("expanded", expanded);
    el.querySelectorAll(".tag-chip").forEach(function (chip) {
      if (!chip.dataset.tag) return;
      chip.addEventListener("click", function () {
        var active = chip.classList.contains("active");
        document.querySelectorAll(".tag-chip").forEach(function (c) { c.classList.remove("active"); });
        if (active) {
          state.tagId = null;
        } else {
          chip.classList.add("active");
          state.tagId = chip.dataset.tag;
        }
        state.offset = 0;
        syncExportButton();
        loadBookmarks(false);
      });
    });
  }

  // 导出按钮在列表被筛选时出现（标签、搜索词、收藏或归档视图）。
  // 导出范围 = 当前列表的全部结果（跨分页），过滤条件与列表完全一致。
  function syncExportButton() {
    var btn = document.getElementById("export-urls");
    if (!btn) return;
    btn.classList.toggle("hidden", !(state.tagId || state.search || state.filter !== "all"));
  }

  // 一键导出：拿该标签下全部书签 URL，一行一个，浏览器直接下载 txt。
  // 文件内容与文件名都由服务端生成（含标签名与日期），前端只负责触发下载。
  document.getElementById("export-urls").addEventListener("click", async function () {
    if (!state.tagId && !state.search && state.filter === "all") return;
    var btn = this;
    if (btn.disabled) return;
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "导出中…";
    try {
      var payload = { format: "txt" };
      if (state.tagId) payload.tagId = state.tagId;
      if (state.search) payload.q = state.search;
      if (state.filter === "fav") payload.favourited = true;
      if (state.filter === "archived") payload.archived = true;
      var data = await trpc("tags.exportBookmarks", payload, "GET");
      if (!data.count) { toast("当前列表没有可导出的 URL"); return; }
      var blob = new Blob([data.content], { type: data.contentType });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = data.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 立刻 revoke 会让部分浏览器取消下载，挪到下一轮事件循环
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
      toast("已导出 " + data.count + " 条 URL");
    } catch (err) {
      toast(err.message || "导出失败", true);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  // ---- 书签操作 ----
  document.getElementById("bookmark-list").addEventListener("click", async function (e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.dataset.act;
    var id = btn.dataset.id;

    if (act === "toggle-detail") {
      state.expandedId = state.expandedId === id ? null : id;
      state.confirmDeleteId = null;
      state.tagEditId = null;
      patchBookmarkCard(id);
      return;
    }
    if (act === "ask-del") {
      state.confirmDeleteId = id;
      state.tagEditId = null;
      patchBookmarkCard(id);
      return;
    }
    if (act === "cancel-del") {
      state.confirmDeleteId = null;
      patchBookmarkCard(id);
      return;
    }
    if (act === "confirm-del") {
      try {
        await trpc("bookmarks.deleteBookmark", { bookmarkId: id });
        state.confirmDeleteId = null;
        toast("书签已删除");
        removeBookmarkCard(id);
        loadTagFilter();
      } catch (err) {
        toast(err.message || "删除失败", true);
      }
      return;
    }
    if (act === "retry-tagging") {
      var rbtn = btn;
      if (rbtn.disabled) return;
      rbtn.disabled = true;
      rbtn.textContent = "重试中…";
      try {
        await trpc("bookmarks.retryTagging", { bookmarkId: id });
        toast("已重新入队，正在用当前模型生成标签");
        patchBookmarkCard(id, { taggingStatus: "pending" });
        // 轮询等待打标签完成（最多 60s，每 3s 一次）
        var tries = 0;
        var tick = setInterval(async function () {
          tries++;
          try {
            var bm = await trpc("bookmarks.getBookmark", { bookmarkId: id }, "GET");
            if (bm.taggingStatus !== "pending" || tries >= 20) {
              clearInterval(tick);
              await loadBookmarks(true);
              await loadTagFilter();
            }
          } catch (err) { clearInterval(tick); }
        }, 3000);
      } catch (err) {
        rbtn.disabled = false;
        rbtn.textContent = "重试";
        toast(err.message || "重试失败", true);
      }
      return;
    }
    if (act === "toggle-fav") {
      try {
        var nowFav = btn.classList.contains("on");
        await trpc("bookmarks.updateBookmark", { bookmarkId: id, favourited: !nowFav });
        toast(nowFav ? "已取消收藏" : "已收藏");
        patchBookmarkCard(id, { favourited: !nowFav });
      } catch (err) { toast(err.message || "操作失败", true); }
      return;
    }
    if (act === "toggle-arch") {
      try {
        var nowArch = btn.classList.contains("on");
        await trpc("bookmarks.updateBookmark", { bookmarkId: id, archived: !nowArch });
        toast(nowArch ? "已取消归档" : "已归档");
        if (state.filter === "archived") {
          removeBookmarkCard(id);
        } else {
          patchBookmarkCard(id, { archived: !nowArch });
        }
      } catch (err) { toast(err.message || "操作失败", true); }
      return;
    }
    if (act === "edit-tags") {
      state.tagEditId = state.tagEditId === id ? null : id;
      state.confirmDeleteId = null;
      patchBookmarkCard(id);
      if (state.tagEditId === id) loadTagCandidates(id);
      return;
    }
    if (act === "tag-remove") {
      var tid = btn.dataset.tag;
      try {
        await trpc("bookmarks.updateTags", { bookmarkId: id, attach: [], detach: [{ tagId: tid }] });
        var bm = state.bmCache[id];
        if (bm) {
          applyTagChange(bm, [], [tid]);
          patchBookmarkCard(id);
          loadTagCandidates(id);
        }
        loadTagFilter();
      } catch (err) { toast(err.message || "移除标签失败", true); }
      return;
    }
    if (act === "tag-add") {
      var input = document.querySelector('[data-tag-input="' + id + '"]');
      if (!input) return;
      await addTagToBookmark(id, input.value);
      input.value = "";
      loadTagCandidates(id);
      return;
    }
    if (act === "tag-opt-toggle") {
      var optTid = btn.dataset.tag;
      var optBm = state.bmCache[id];
      var optOn = optBm && optBm.tags.some(function (t) { return t.id === optTid; });
      try {
        var optRes = await trpc("bookmarks.updateTags", {
          bookmarkId: id,
          attach: optOn ? [] : [{ tagId: optTid }],
          detach: optOn ? [{ tagId: optTid }] : []
        });
        if (optBm) {
          if (optOn) {
            applyTagChange(optBm, [], [optTid]);
          } else {
            var optTag = (state.allTags || []).filter(function (t) { return t.id === optTid; })[0];
            applyTagChange(optBm, [{ id: optTid, name: optTag ? optTag.name : "" }], []);
          }
          patchBookmarkCard(id);
          loadTagCandidates(id);
        }
        loadTagFilter();
      } catch (err) { toast(err.message || "操作失败", true); }
      return;
    }
  });

  // 标签编辑器：回车添加
  document.getElementById("bookmark-list").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var input = e.target.closest("[data-tag-input]");
    if (!input) return;
    e.preventDefault();
    var id = input.getAttribute("data-tag-input");
    addTagToBookmark(id, input.value).then(function () {
      input.value = "";
      loadTagCandidates(id);
    });
  });

  // ---- 保存书签 ----
  document.getElementById("save-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var errEl = document.getElementById("save-error");
    var btn = document.getElementById("save-submit");
    errEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "保存中…";
    try {
      var payload = {
        type: "link",
        url: document.getElementById("save-url").value.trim(),
        title: document.getElementById("save-title").value.trim() || null,
        source: "web"
      };
      var note = document.getElementById("save-note").value.trim();
      if (note) payload.note = note;
      var result = await trpc("bookmarks.createBookmark", payload);
      document.getElementById("save-url").value = "";
      document.getElementById("save-title").value = "";
      document.getElementById("save-note").value = "";
      toast(result.alreadyExists ? "书签已存在" : "书签已保存");
      state.filter = "all";
      document.querySelectorAll(".filter-btn").forEach(function (b) {
        b.classList.toggle("active", b.dataset.filter === "all");
      });
      state.tagId = null;
      document.querySelectorAll(".tag-chip").forEach(function (c) { c.classList.remove("active"); });
      syncExportButton();
      await loadBookmarks(false);
      await loadTagFilter();
      // 轮询等待标签生成（最多 60s，每 3s 一次）
      var attempts = 0;
      var timer = setInterval(async function () {
        attempts++;
        try {
          var data = await trpc("bookmarks.getBookmarks", { limit: 20, includeContent: false }, "GET");
          var pending = (data.bookmarks || []).some(function (b) { return b.taggingStatus === "pending"; });
          if (!pending || attempts >= 20) {
            clearInterval(timer);
            await loadBookmarks(true);
            await loadTagFilter();
          }
        } catch (err) {
          clearInterval(timer);
        }
      }, 3000);
    } catch (err) {
      errEl.textContent = err.message || "保存失败";
    } finally {
      btn.disabled = false;
      btn.textContent = "保存";
    }
  });

  // ---- 自动刷新 ----
  function startAutoRefresh() {
    stopAutoRefresh();
    state.refreshTimer = setInterval(async function () {
      if (document.getElementById("bookmarks-view").classList.contains("hidden")) return;
      try {
        var list = await fetchBookmarksPage();
        renderBookmarks(list);
        updateCountLabel();
        updatePagination();
      } catch (e) { /* 静默失败，下次重试 */ }
    }, 15000);
  }
  function stopAutoRefresh() {
    if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
  }

  // ---- 数据导入（后台任务）----
  var importJobs = [];
  var importPollTimer = null;

  var KIND_NAMES = { import: "导入", fix: "修复", retag: "重新统计标签", translate: "翻译标签", "retry-tagging": "重试失败标签" };
  function kindName(kind) { return KIND_NAMES[kind] || "任务"; }
  function fmtJobStatus(job) {
    if (job.status === "pending") return "排队中";
    if (job.status === "running") return kindName(job.kind) + "中 " + (job.imported + job.skipped + job.failed) + "/" + job.total;
    if (job.status === "success") return kindName(job.kind) + "完成";
    return "失败";
  }

  function jobIconHtml(kind, status) {
    var icon = kind === "fix"
      ? '<path d="M12 4v10m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/>'
      : kind === "retag"
        ? '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="17" r="2"/>'
        : kind === "translate"
          ? '<path d="M4 5h10M9 3v2M6.5 5c0 4 3 7 7 8M13 13l-2 2M11 15l-3 3M8 12c-1.5-1-3-3-3.5-5"/>'
          : kind === "retry-tagging"
            ? '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>'
            : '<path d="M12 5v14m0 0 5-5m-5 5-5-5"/><line x1="4" y1="4" x2="4" y2="8"/><line x1="4" y1="4" x2="8" y2="4"/>';
    if (status === "success") icon = '<path d="M5 12.5 10 17.5 19.5 7"/>';
    if (status === "failed") icon = '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>';
    return '<svg class="ic" viewBox="0 0 24 24">' + icon + "</svg>";
  }

  function renderImportJobs() {
    var el = document.getElementById("import-jobs");
    if (!importJobs.length) {
      el.innerHTML = '<div class="empty" style="padding:26px 14px;font-size:13px;border-style:solid">暂无导入记录</div>';
      return;
    }
    var html = "";
    for (var i = 0; i < importJobs.length; i++) {
      var j = importJobs[i];
      var stateCls = j.status === "success" ? "ok" : j.status === "failed" ? "fail" : "run";
      var detail = j.status === "success"
        ? (j.kind === "retag"
            ? "已统计 " + j.imported + " 个标签"
            : j.kind === "translate"
              ? "翻译 " + j.skipped + " 个标签" + (j.failed > 0 ? " · 失败 " + j.failed : "")
              : j.kind === "retry-tagging"
                ? "重新入队 " + j.imported + " 条" + (j.skipped > 0 ? " · 跳过 " + j.skipped : "") + (j.failed > 0 ? " · 失败 " + j.failed : "")
                : "新增 " + j.imported + " · 跳过 " + j.skipped + (j.failed > 0 ? " · 失败 " + j.failed : ""))
        : j.status === "failed"
          ? (j.error || "任务失败")
          : "已处理 " + (j.imported + j.skipped + j.failed) + "/" + j.total;
      html +=
        '<div class="job" data-id="' + j.id + '">' +
          '<div class="j-state ' + stateCls + '">' + jobIconHtml(j.kind, j.status) + "</div>" +
          '<div class="j-body">' +
            '<div class="j-src" title="' + esc(j.sourceUrl) + '">' + kindName(j.kind) + (j.sourceUrl ? " · " + esc(j.sourceUrl) : "") + "</div>" +
            '<div class="j-desc">' + fmtJobStatus(j) + " · " + esc(detail) + "</div>" +
          "</div>" +
          '<div class="j-actions">' +
            (j.status === "failed" ? '<button type="button" class="btn secondary sm" data-act="retry">重试</button>' : "") +
            (j.status === "success" && j.kind === "import" ? '<button type="button" class="btn secondary sm" data-act="fix">修复</button>' : "") +
          "</div>" +
        "</div>";
    }
    el.innerHTML = html;
  }

  async function loadImportJobs() {
    try {
      importJobs = await trpc("imports.listImportJobs", {}, "GET");
      renderImportJobs();
    } catch (e) { /* 静默 */ }
  }

  function startImportPolling() {
    if (importPollTimer) return;
    importPollTimer = setInterval(function () {
      loadImportJobs();
    }, 4000);
  }
  function stopImportPolling() {
    if (importPollTimer) { clearInterval(importPollTimer); importPollTimer = null; }
  }
  document.addEventListener("beforeunload", function () { stopImportPolling(); stopAutoRefresh(); });

  // ---- 重试失败标签：失败计数驱动按钮徽标与可用态 ----
  var failedTaggingCount = 0;
  var failedTaggingFailed = 0;
  var failedTaggingNever = 0;
  var failedTaggingStuck = 0;
  function renderFailedTaggingCount() {
    var btn = document.getElementById("mtn-retry-tagging");
    var badge = document.getElementById("mtn-retry-count");
    if (!btn || !badge) return;
    badge.textContent = String(failedTaggingCount);
    badge.classList.toggle("hidden", failedTaggingCount === 0);
    btn.disabled = failedTaggingCount === 0;
    btn.title = failedTaggingCount === 0 ? "当前没有打标签失败的书签" : "把 " + failedTaggingCount + " 条失败书签重新入队";
  }
  function renderTaggingFailure(reason) {
    var el = document.getElementById("mtn-retry-hint");
    if (!el) return;
    if (!reason && failedTaggingCount === 0) {
      el.textContent = "打标签失败、以及从未打过标签的书签会重新入队，并用当前保存的模型重跑。";
      el.style.color = "";
      return;
    }
    // 三类分开说清：失败 / 从未打过标签（原本连徽标都没有）/ 卡在生成中（job 已终态）
    var parts = [];
    if (failedTaggingFailed > 0) parts.push(failedTaggingFailed + " 条标签失败");
    if (failedTaggingNever > 0) parts.push(failedTaggingNever + " 条从未打过标签");
    if (failedTaggingStuck > 0) parts.push(failedTaggingStuck + " 条卡在生成中");
    var head = parts.length ? parts.join(" · ") : "";
    el.textContent = head + (reason ? (head ? " · " : "") + "最近失败原因：" + reason.message : "");
    el.style.color = reason ? "var(--danger)" : "";
  }
  async function loadFailedTaggingCount() {
    try {
      var data = await trpc("imports.failedTaggingCount", {}, "GET");
      failedTaggingCount = data.count || 0;
      failedTaggingFailed = data.failed || 0;
      failedTaggingNever = data.neverTagged || 0;
      failedTaggingStuck = data.stuck || 0;
      renderTaggingFailure(data.recentFailure);
    } catch (e) {
      failedTaggingCount = 0;
      failedTaggingFailed = 0;
      failedTaggingNever = 0;
      failedTaggingStuck = 0;
      renderTaggingFailure(null);
    }
    renderFailedTaggingCount();
  }

  document.getElementById("import-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var errEl = document.getElementById("import-error");
    var btn = document.getElementById("import-submit");
    errEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      var payload = {
        sourceUrl: document.getElementById("import-url").value.trim(),
        email: document.getElementById("import-email").value.trim(),
        password: document.getElementById("import-password").value
      };
      var job = await trpc("imports.startImportJob", payload);
      toast("导入任务已创建，后台执行中");
      document.getElementById("import-password").value = "";
      await loadImportJobs();
      startImportPolling();
    } catch (err) {
      errEl.textContent = err.message || "创建导入任务失败";
    } finally {
      btn.disabled = false;
      btn.textContent = "开始导入";
    }
  });

  document.querySelectorAll("[data-mtn]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var kind = btn.getAttribute("data-mtn");
      var label = kind === "import" ? "导入" : kind === "retag" ? "重新统计标签" : kind === "retry-tagging" ? "重试失败标签" : "翻译标签";
      // 保留 innerHTML（按钮内含失败计数徽标），文本替换后需可还原
      var oldHtml = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = "创建中…";
      try {
        if (kind === "import") {
          document.getElementById("import-url").focus();
          toast("请填写源服务器信息后点击「开始导入」");
        } else if (kind === "retry-tagging") {
          var job = await trpc("imports.retryFailedTagging", {});
          toast("已重新入队 " + (job.total || 0) + " 条失败书签，后台处理中");
          await loadImportJobs();
          await loadFailedTaggingCount();
          startImportPolling();
          loadBookmarks(true);
        } else {
          await trpc("imports.startMaintenanceJob", { kind: kind });
          toast(label + "任务已创建，后台执行中");
          await loadImportJobs();
          startImportPolling();
        }
      } catch (err) {
        toast(err.message || "创建" + label + "任务失败");
      } finally {
        btn.innerHTML = oldHtml;
        // 还原后按最新计数重算可用态（失败数可能已变化）
        renderFailedTaggingCount();
      }
    });
  });

  document.getElementById("import-jobs").addEventListener("click", async function (e) {
    var btn = e.target.closest("button[data-act='retry'], button[data-act='fix']");
    if (!btn) return;
    if (btn.disabled) return;
    var jobEl = btn.closest(".job");
    if (!jobEl) return;
    var jobId = jobEl.getAttribute("data-id");
    var isFix = btn.getAttribute("data-act") === "fix";
    btn.disabled = true;
    btn.textContent = isFix ? "修复中…" : "重试中…";
    try {
      if (isFix) {
        await trpc("imports.fixImportedData", { jobId: jobId });
        toast("修复任务已创建，后台执行中");
      } else {
        await trpc("imports.retryImportJob", { jobId: jobId });
        toast("已重新入队");
      }
      await loadImportJobs();
      startImportPolling();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = isFix ? "修复" : "重试";
      var errEl = document.getElementById("import-error");
      errEl.textContent = err.message || (isFix ? "创建修复任务失败" : "重试失败");
    }
  });

  // ---- AI 提供商 ----
  var PROVIDER_META = {
    "workers-ai": { name: "Workers AI", desc: "使用部署账户的 AI 绑定，无需 API Key；每日 10,000 Neurons 免费额度（UTC 0 点重置），免费计划用尽后报错，付费计划按量计费", defaultUrl: "" },
    "openrouter": { name: "OpenRouter", desc: "聚合多家模型，按量付费（零价模型标「免费」）", defaultUrl: "https://openrouter.ai/api/v1" },
    "ollama-cloud": { name: "Ollama Cloud", desc: "Ollama 官方云服务", defaultUrl: "https://ollama.com" },
    "opencode-go": { name: "OpenCode Go", desc: "OpenCode 订阅制模型服务；只列出可走 chat completions 的模型，官方零价模型标「免费」", defaultUrl: "https://opencode.ai/inference/go/openai/v1" }
  };
  var providerModels = {};
  var selection = null;

  function providerIcon(p) {
    if (p === "workers-ai") return '<path d="M12 2 4 7v10l8 5 8-5V7l-8-5Z"/><path d="M12 22V12"/><path d="m4 7 8 5 8-5"/>';
    if (p === "openrouter") return '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M19.1 4.9l-2.8 2.8M7.7 16.3l-2.8 2.8"/>';
    if (p === "opencode-go") return '<path d="M4 7h16v10H4z"/><path d="m8 11 2 2-2 2M13 15h3"/>';
    return '<path d="M4 17V7a1 1 0 0 1 1.5-.9l12 6a1 1 0 0 1 0 1.8l-12 6A1 1 0 0 1 4 17Z"/>';
  }

  // 模型展示文案：免费/推荐标签统一走这里，卡片下拉与「模型选择」保持一致
  function modelLabel(x) {
    return x.name + (x.recommended ? " · 推荐" : "") + (x.free ? " · 免费" : "");
  }

  function renderProviderList(providers) {
    var list = document.getElementById("provider-list");
    var html = "";
    Object.keys(PROVIDER_META).forEach(function (p) {
      var meta = PROVIDER_META[p];
      var cfg = providers.find(function (x) { return x.provider === p; });
      var badge = cfg
        ? '<span class="p-badge ok">已配置' + (cfg.apiKeyConfigured ? " · Key 已存" : "") + "</span>"
        : '<span class="p-badge no">未配置</span>';
      // Workers AI 走部署账户的 AI 绑定，没有 Base URL / API Key 可填
      var credRow = p === "workers-ai"
        ? '<div class="e-row"><div class="field"><label>凭据</label>' +
          '<div class="p-desc" style="margin:0">使用部署账户的 Workers AI 绑定，无需 API Key</div></div></div>'
        : '<div class="e-row">' +
            '<div class="field"><label>Base URL</label><input type="url" data-f="url" placeholder="' + meta.defaultUrl + '"></div>' +
            '<div class="field"><label>API Key（留空保持不变）</label><input type="password" data-f="key" autocomplete="off" placeholder="sk-..."></div>' +
          "</div>";
      html +=
        '<div class="provider-item" data-provider="' + p + '">' +
          '<div class="p-head">' +
            '<div class="p-icon"><svg class="ic" viewBox="0 0 24 24">' + providerIcon(p) + "</svg></div>" +
            '<div><div class="p-name">' + meta.name + "</div><div class='p-desc'>" + meta.desc + "</div></div>" +
            badge +
            '<button type="button" class="btn secondary sm" data-act="edit">' + (cfg ? "编辑" : "配置") + "</button>" +
          "</div>" +
          '<div class="edit-form">' +
            credRow +
            '<div class="e-line">' +
              '<button type="button" class="btn secondary sm" data-act="fetch">拉取模型列表</button>' +
              '<span class="e-status fetch-status"></span>' +
            "</div>" +
            '<div class="e-line">' +
              '<select data-f="chat"><option value="">对话模型</option></select>' +
              '<select data-f="embed"><option value="">向量模型</option></select>' +
            "</div>" +
            '<div class="e-line">' +
              '<button type="button" class="btn sm" data-act="save">保存</button>' +
              '<span class="e-status save-status"></span>' +
              '<button type="button" class="btn secondary sm" data-act="test">测试连接</button>' +
              '<span class="e-status test-status"></span>' +
            "</div>" +
            '<div class="err" style="margin-top:8px"></div>' +
          "</div>" +
        "</div>";
    });
    list.innerHTML = html;
    list.querySelectorAll(".provider-item").forEach(function (card) {
      var p = card.dataset.provider;
      var cfg = providers.find(function (x) { return x.provider === p; });
      if (cfg && cfg.baseUrl) card.querySelector('[data-f="url"]').value = cfg.baseUrl;
      card.querySelector('[data-act="edit"]').addEventListener("click", function () {
        card.classList.toggle("open");
      });
      card.querySelector('[data-act="fetch"]').addEventListener("click", function () { fetchModels(card, p); });
      card.querySelector('[data-act="save"]').addEventListener("click", function () { saveProvider(card, p); });
      card.querySelector('[data-act="test"]').addEventListener("click", function () { testProvider(card, p); });
    });
  }

  async function testProvider(card, provider) {
    var errEl = card.querySelector(".err");
    var statusEl = card.querySelector(".test-status");
    errEl.textContent = "";
    statusEl.textContent = "测试中…";
    statusEl.className = "e-status test-status";
    try {
      var data = await trpc("llm.testProvider", { provider: provider });
      statusEl.textContent = data.message + (data.latencyMs != null ? "（" + data.latencyMs + "ms）" : "");
      statusEl.className = "e-status test-status " + (data.ok ? "ok" : "no");
    } catch (err) {
      statusEl.textContent = err.message || "测试失败";
      statusEl.className = "e-status test-status no";
    }
  }

  async function fetchModels(card, provider) {
    var errEl = card.querySelector(".err");
    var statusEl = card.querySelector(".fetch-status");
    errEl.textContent = "";
    statusEl.textContent = "拉取中…";
    try {
      var urlEl = card.querySelector('[data-f="url"]');
      var keyEl = card.querySelector('[data-f="key"]');
      var url = urlEl ? urlEl.value.trim() || undefined : undefined;
      var key = keyEl ? keyEl.value : "";
      var payload = { provider: provider };
      if (url) payload.baseUrl = url;
      if (key) payload.apiKey = key;
      await trpc("llm.setProviderConfig", payload);
      if (keyEl) keyEl.value = "";
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
        o.textContent = modelLabel(x);
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
        o.textContent = modelLabel(x);
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
      var urlEl = card.querySelector('[data-f="url"]');
      var keyEl = card.querySelector('[data-f="key"]');
      var url = urlEl ? urlEl.value.trim() || undefined : undefined;
      var key = keyEl ? keyEl.value : "";
      var payload = { provider: provider };
      if (url) payload.baseUrl = url;
      if (key) payload.apiKey = key;
      await trpc("llm.setProviderConfig", payload);
      if (keyEl) keyEl.value = "";
      statusEl.textContent = "已保存";
      statusEl.className = "e-status save-status ok";
      loadLlmConfig();
    } catch (err) {
      errEl.textContent = err.message || "保存失败";
    }
  }

  function fillSelectionSelects(sel) {
    var chatSel = document.getElementById("chat-model-select");
    var embedSel = document.getElementById("embed-model-select");
    chatSel.innerHTML = "";
    embedSel.innerHTML = "";
    var chatOpts = [];
    Object.keys(providerModels).forEach(function (p) {
      providerModels[p].chat.forEach(function (x) {
        chatOpts.push({ provider: p, id: x.id, label: modelLabel(x) });
      });
    });
    if (chatOpts.length) {
      chatOpts.forEach(function (x) {
        var o = document.createElement("option");
        o.value = x.provider + "::" + x.id;
        o.textContent = "[" + (PROVIDER_META[x.provider] || {}).name + "] " + x.label;
        chatSel.appendChild(o);
      });
      var cur = sel.chatProvider + "::" + sel.chatModel;
      if (chatOpts.some(function (x) { return x.provider + "::" + x.id === cur; })) {
        chatSel.value = cur;
      } else {
        // 已保存的模型不在列表里（下线/改名）→ 不能悄悄选中别的模型，
        // 否则用户以为「我保存的就是这个」，实际库里还是旧值。
        var saved = document.createElement("option");
        saved.value = cur;
        saved.textContent = "[" + (PROVIDER_META[sel.chatProvider] || {}).name + "] " + sel.chatModel + "（当前已保存 · 不在可用列表中）";
        chatSel.insertBefore(saved, chatSel.firstChild);
        chatSel.value = cur;
      }
    } else {
      var none = document.createElement("option");
      none.value = "";
      none.textContent = "先在上方配置 provider 并拉取模型";
      chatSel.appendChild(none);
    }
    var embOpts = [];
    Object.keys(providerModels).forEach(function (p) {
      providerModels[p].embedding.forEach(function (x) {
        embOpts.push({ provider: p, id: x.id, label: modelLabel(x) });
      });
    });
    var noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "不使用向量模型";
    embedSel.appendChild(noneOpt);
    embOpts.forEach(function (x) {
      var o = document.createElement("option");
      o.value = x.provider + "::" + x.id;
      o.textContent = "[" + (PROVIDER_META[x.provider] || {}).name + "] " + x.label;
      embedSel.appendChild(o);
    });
    if (sel.embeddingProvider && sel.embeddingModel) {
      var curE = sel.embeddingProvider + "::" + sel.embeddingModel;
      if (embOpts.some(function (x) { return x.provider + "::" + x.id === curE; })) {
        embedSel.value = curE;
      }
    }
  }

  // 保存模型选择：读回服务端真实值再显示。
  // 教训：旧模型被下线后，下拉框曾经静默显示别的模型，用户以为已保存，
  // 实际库里还是旧值，打标签失败一个月都查不出来。
  var savingSelection = false;
  async function saveSelection(quiet) {
    var errEl = document.getElementById("llm-error");
    var statusEl = document.getElementById("llm-status");
    if (savingSelection) return;
    savingSelection = true;
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
      var saved = await trpc("llm.getConfigs", {}, "GET");
      selection = saved.selection;
      statusEl.textContent = "已保存：" + saved.selection.chatProvider + " / " + saved.selection.chatModel;
      if (failedTaggingCount > 0) {
        statusEl.textContent += " · 可点「重试失败标签」用新模型重跑";
      }
      toast(quiet ? "已保存：" + saved.selection.chatModel : "模型选择已保存");
    } catch (err) {
      errEl.textContent = err.message || "保存失败";
      if (quiet) toast(err.message || "保存失败", true);
    } finally {
      savingSelection = false;
    }
  }

  document.getElementById("save-selection").addEventListener("click", function () {
    saveSelection(false);
  });

  // 改下拉框即保存：避免「选好了但没点保存」——这是模型被下线后一直没换过来的直接原因
  ["chat-model-select", "embed-model-select"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", function () {
      saveSelection(true);
    });
  });

  async function loadLlmConfig() {
    var errEl = document.getElementById("llm-error");
    try {
      var cfg = await trpc("llm.getConfigs", {}, "GET");
      selection = cfg.selection;
      renderProviderList(cfg.providers);
      // workers-ai 不需要 Key（走部署账户的 AI 绑定），必须一并拉取，
      // 否则模型选择下拉框里看不到 Workers AI 的模型（含默认模型）。
      var configured = [{ provider: "workers-ai" }].concat(
        cfg.providers.filter(function (p) { return p.apiKeyConfigured; })
      );
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

  // ---- 账户视图 ----
  var SETTING_LABELS = {
    bookmarkClickAction: { open_original_link: "打开原文", open_reader_view: "阅读视图" },
    archiveDisplayBehaviour: { show: "显示归档", hide: "隐藏归档" }
  };
  function niceValue(key, v) {
    var map = SETTING_LABELS[key];
    return map && map[v] ? map[v] : (v == null || v === "" ? "—" : String(v));
  }
  async function loadAccount() {
    try {
      if (!user) { user = await trpc("users.whoami", {}, "GET"); }
      var name = user.name || "";
      document.getElementById("user-avatar").textContent = (name || user.email || "?").charAt(0).toUpperCase();
      document.getElementById("user-name").textContent = name || (user.email || "").split("@")[0] || "用户";
      document.getElementById("user-mail").textContent = user.email || "";
      document.getElementById("nav-bm-count").textContent = "";

      var init = (user.name || user.email || "U").charAt(0).toUpperCase();
      var hero = document.getElementById("profile-hero");
      hero.innerHTML =
        '<div class="avatar-lg">' + esc(init) + "</div>" +
        '<div style="min-width:0"><div class="ph-name">' + esc(name || "未命名") + "</div>" +
        '<div class="ph-mail">' + esc(user.email || "") + "</div></div>" +
        '<span class="ph-tag pill on">本机账户</span>';
      document.getElementById("acc-name").textContent = name || "未命名";
      document.getElementById("acc-email").textContent = user.email || "—";
      document.getElementById("acc-id").textContent = user.id || "—";
      document.getElementById("acc-click").textContent = "";
      document.getElementById("acc-archive").textContent = "";
      document.getElementById("acc-tz").textContent = "";
      try {
        var s = await trpc("users.settings", {}, "GET");
        document.getElementById("acc-click").textContent = niceValue("bookmarkClickAction", s.bookmarkClickAction);
        document.getElementById("acc-archive").textContent = niceValue("archiveDisplayBehaviour", s.archiveDisplayBehaviour);
        document.getElementById("acc-tz").textContent = s.timezone || "—";
        var backup = document.getElementById("acc-backup");
        if (s.backupsEnabled) { backup.className = "pill on"; backup.textContent = "每周备份"; }
        else { backup.className = "pill off"; backup.textContent = "未启用"; }
      } catch (e) { /* 设置不可用不阻塞 */ }
    } catch (err) {
      /* 加载失败静默，下次进入重试 */
    }
  }

  // ---- 启动 ----
  async function loadApp() {
    try {
      user = await trpc("users.whoami", {}, "GET");
      var name = user.name || "";
      document.getElementById("user-avatar").textContent = (name || user.email || "?").charAt(0).toUpperCase();
      document.getElementById("user-name").textContent = name || (user.email || "").split("@")[0] || "用户";
      document.getElementById("user-mail").textContent = user.email || "";
      document.getElementById("nav-bm-count").textContent = "";
      showApp();
      switchView("bookmarks");
      await loadBookmarks(false);
      await loadTagFilter();
      startAutoRefresh();
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

export async function handleDashboard(env: Env): Promise<Response> {
  // 页脚版本号必须来自 SERVER_VERSION：写死的 v0.2.0 曾让人以为线上跑的是另一个版本，
  // 白白浪费一轮排查（真实 /api/version 一直是 0.1.0）。
  const version = /^[0-9A-Za-z._-]{1,20}$/.test(env.SERVER_VERSION ?? "") ? env.SERVER_VERSION : "dev";
  return new Response(DASHBOARD_HTML.replace("__SERVER_VERSION__", version), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
