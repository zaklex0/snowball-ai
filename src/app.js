(function () {
  "use strict";

  var api = window.vsApi;

  // Categories in display order. To add one, add a line here and a colour set in styles.css.
  var CATEGORIES = [
    { key: "статика",   label: "Статика",   cls: "cat-static" },
    { key: "видео",     label: "Видео",     cls: "cat-video" },
    { key: "системные", label: "Системные", cls: "cat-system" }
  ];
  var IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg", "ico"];
  var VIDEO_EXT = ["mp4", "webm", "mov", "m4v", "ogv", "mkv"];
  var AUDIO_EXT = ["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"];
  // Kinds of actions counted on the statistics page (storage.js counts them).
  var ACTIONS = ["created", "edited", "files", "copied", "calendar", "assistant", "tasks"];
  // How the statistics page groups them in "Что вы чаще всего делаете".
  var USE_GROUPS = [
    { name: "Промты: новые и правки", keys: ["created", "edited"], icon: "pencil" },
    { name: "Календарь", keys: ["calendar"], icon: "calendar" },
    { name: "Задачи", keys: ["tasks"], icon: "tasks" },
    { name: "Ассистент", keys: ["assistant"], icon: "spark" },
    { name: "Копирование промтов", keys: ["copied"], icon: "copy" },
    { name: "Файлы к промтам", keys: ["files"], icon: "clip" }
  ];
  var MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  var MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  var WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];

  var state = {
    loaded: false,
    page: "prompts",      // what the open tab shows, a key of els.views: "home", "prompts", "calendar", "tasks", "assistant" (LLM), "generator", "stats"
    items: [],
    info: null,
    profile: null,        // { name, welcomed, avatar }
    activity: null,       // { since, days: { "2026-10-22": { created, edited, files, copied } } }
    events: [],           // calendar: { id, date "2026-11-03", from "15:00", to, title, kind, note, remind }
    tasks: [],            // tasks board: { id, title, status "todo" | "doing" | "done", note, order }
    query: "",
    type: "all",
    expanded: new Set(),
    notesOpen: new Set(),   // prompts whose comment is shown in full
    confirmId: null,
    editingId: null,
    editorOpen: false,
    draft: null,          // { existing: [], removed: Set, pending: [] }
    dropRowId: null
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    titlebar: $("titlebar"), scroller: $("scroller"),
    meta: $("meta"), addBtn: $("add-btn"), menuBtn: $("menu-btn"), menu: $("menu"),
    banner: $("banner"), bannerText: $("banner-text"), bannerAction: $("banner-action"), bannerClose: $("banner-close"),
    editorSlot: $("editor-slot"), editor: $("editor"), editorTitle: $("editor-title"),
    fTitle: $("f-title"), fCat: $("f-cat"), fText: $("f-text"), fComment: $("f-comment"), fFiles: $("f-files"),
    saveBtn: $("save-btn"), cancelBtn: $("cancel-btn"), formMsg: $("form-msg"),
    toolbar: $("toolbar"), search: $("search"), filters: $("filters"),
    table: $("table"), rows: $("rows"), stateBox: $("state"), toast: $("toast"),
    viewer: $("viewer"), viewerTitle: $("viewer-title"), viewerBody: $("viewer-body"),
    viewerOpen: $("viewer-open"), viewerShow: $("viewer-show"), viewerClose: $("viewer-close"),
    navItems: Array.prototype.slice.call(document.querySelectorAll(".side [data-page]")),
    badges: Array.prototype.slice.call(document.querySelectorAll(".nav-badge[data-badge]")), homeGrid: $("home-grid"), homeTitle: $("home-title"), homeDate: $("home-date"),
    views: {
      prompts: $("view-prompts"), generator: $("view-generator"), calendar: $("view-calendar"), assistant: $("view-assistant"),
      tasks: $("view-tasks"), stats: $("view-stats"), home: $("view-home")
    },
    sideAvatar: $("side-avatar"), sideName: $("side-name"),
    menuAvatar: $("menu-avatar"), menuName: $("menu-name"), menuSub: $("menu-sub"),
    statsAvatar: $("stats-avatar"), statsName: $("stats-name"), statsSince: $("stats-since"), statsEdit: $("stats-edit"),
    metrics: $("metrics"), topList: $("top-list"), heat: $("heat"), heatTip: $("heat-tip"), breakdown: $("breakdown"),
    updCard: $("set-update"), updBadge: $("upd-badge"), updLine: $("upd-line"), updBar: $("upd-bar"), updBarFill: $("upd-bar-fill"),
    updActions: $("upd-actions"), updNew: $("upd-new"), updNewTitle: $("upd-new-title"), updNewBody: $("upd-new-body"),
    settingsDlg: $("settings-dlg"), settingsClose: $("settings-close"), settingsMain: $("settings-main"), setBackupMsg: $("set-backup-msg"),
    updCurrent: $("upd-current"), updCurrentTitle: $("upd-current-title"), updCurrentBody: $("upd-current-body"), setNavDot: $("set-nav-dot"),
    chat: $("chat"), chatEmpty: $("chat-empty"), chatIdeas: $("chat-ideas"), chatNew: $("chat-new"),
    composer: $("composer"), chatInput: $("chat-input"), chatSend: $("chat-send"),
    calMeta: $("cal-meta"), calAdd: $("cal-add"), calTitle: $("cal-title"), calToday: $("cal-today"), calPrev: $("cal-prev"), calNext: $("cal-next"),
    calDialog: $("cal-dialog"), calViewBtn: $("cal-view-btn"), calViewMenu: $("cal-view-menu"), calViewName: $("cal-view-name"),
    calMonthView: $("cal-month-view"), calWeekView: $("cal-week-view"), cwHead: $("cw-head"), cwBody: $("cw-body"),
    calGrid: $("cal-grid"), calDayTitle: $("cal-day-title"), calDaySub: $("cal-day-sub"), calDayAdd: $("cal-day-add"), calDayBadge: $("cal-day-badge"),
    calForm: $("cal-form"), calFormTitle: $("cal-form-title"), cfTitle: $("cf-title"), cfDate: $("cf-date"), cfFrom: $("cf-from"), cfTo: $("cf-to"),
    cfKind: $("cf-kind"), cfRemind: $("cf-remind"), cfNote: $("cf-note"), cfSave: $("cf-save"), cfCancel: $("cf-cancel"), cfDelete: $("cf-delete"), cfMsg: $("cf-msg"),
    calTimeline: $("cal-timeline"),
    chatMode: $("chat-mode"), chatMeta: $("chat-meta"), chatConnect: $("chat-connect"), setNotify: $("set-notify"), setConfirm: $("set-confirm"),
    setDir: $("set-dir"), setDirChange: $("set-dir-change"), setBackupSave: $("set-backup-save"), setBackupOpen: $("set-backup-open"), themeValue: $("theme-value"),
    tabs: $("tabs"), tabPlus: $("tab-plus"), tabMenu: $("tab-menu"), upList: $("up-list"), board: $("board"), tasksMeta: $("tasks-meta"),
    qa: $("qa"), qaBtn: $("qa-btn"), qaModel: $("qa-model"), qaNew: $("qa-new"), qaFull: $("qa-full"), qaClose: $("qa-close"),
    qaList: $("qa-list"), qaEmpty: $("qa-empty"), qaIdeas: $("qa-ideas"), qaForm: $("qa-form"), qaInput: $("qa-input"), qaSend: $("qa-send"),
    chatHistory: $("chat-history"), chatHistoryBtn: $("chat-history-btn"), chatList: $("chat-list"),
    chatCost: $("chat-cost"), modelBtn: $("model-btn"), modelBtnText: $("model-btn-text"), modelMenu: $("model-menu"),
    profileDlg: $("profile-dlg"), pdForm: $("pd-form"), pdTitle: $("pd-title"), pdText: $("pd-text"),
    pdAvatar: $("pd-avatar"), pdPick: $("pd-pick"), pdRemove: $("pd-remove"), pdName: $("pd-name"),
    pdSave: $("pd-save"), pdCancel: $("pd-cancel"), pdMsg: $("pd-msg"), pdRestore: $("pd-restore"), pdRestoreBtn: $("pd-restore-btn")
  };
  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var ICONS = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>',
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.2-8.2a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.2a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9.5L15.5 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z"/><path d="M15.5 20.5V16a.5.5 0 0 1 .5-.5h4.5M7.5 9h9M7.5 12.5h6"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5-5.5-2L10 9Z"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6h-6v6H5.5A1.5 1.5 0 0 1 4 19Z"/></svg>',
    tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="16.5" y="4" width="4" height="7" rx="1.5"/></svg>',
    prompts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-7l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 16V7A1.5 1.5 0 0 1 5 5.5Z"/></svg>',
    stats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="4" width="4.5" height="4.5" rx="1"/><rect x="9.75" y="4" width="4.5" height="4.5" rx="1"/><rect x="15.5" y="4" width="4.5" height="4.5" rx="1"/><rect x="4" y="9.75" width="4.5" height="4.5" rx="1"/><rect x="9.75" y="9.75" width="4.5" height="4.5" rx="1"/><rect x="4" y="15.5" width="4.5" height="4.5" rx="1"/></svg>'
  };

  /* ---------- helpers ---------- */
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "html") el.innerHTML = v;
        else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid === null || kid === undefined || kid === false) continue;
      if (Array.isArray(kid)) kid.forEach(function (k) { if (k) el.append(k); });
      else el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function icon(name) { return h("span", { class: "ico", html: ICONS[name], "aria-hidden": "true" }); }
  function norm(s) { return String(s || "").trim().toLowerCase(); }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function fmtNum(n) { return n.toLocaleString("ru-RU"); }
  function fmtSize(b) {
    if (!b) return "";
    if (b < 1024) return b + " Б";
    if (b < 1024 * 1024) return Math.round(b / 1024) + " КБ";
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0).replace(".", ",") + " МБ";
    return (b / 1024 / 1024 / 1024).toFixed(1).replace(".", ",") + " ГБ";
  }
  function extOf(name) { var m = /\.([^.]+)$/.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; }
  function kindOf(name) {
    var e = extOf(name);
    if (IMAGE_EXT.indexOf(e) !== -1) return "image";
    if (VIDEO_EXT.indexOf(e) !== -1) return "video";
    if (AUDIO_EXT.indexOf(e) !== -1) return "audio";
    return "file";
  }
  function newId() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function categoryOf(type) {
    var k = norm(type);
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].key === k) return CATEGORIES[i];
    return null;
  }
  function catClass(type) { var c = categoryOf(type); return c ? c.cls : "cat-other"; }
  function sortItems(list) {
    return list.slice().sort(function (a, b) { return (b.createdAt - a.createdAt) || a.title.localeCompare(b.title, "ru"); });
  }
  function matches(item) {
    if (state.type !== "all" && norm(item.type) !== state.type) return false;
    var q = norm(state.query);
    if (!q) return true;
    return norm(item.title).indexOf(q) !== -1 || norm(item.text).indexOf(q) !== -1 || norm(item.type).indexOf(q) !== -1 ||
      norm(item.comment).indexOf(q) !== -1 ||
      item.files.some(function (f) { return norm(f.name).indexOf(q) !== -1; });
  }
  function findItem(id) { return state.items.find(function (i) { return i.id === id; }) || null; }

  /* ---------- dates ---------- */
  function pad2(n) { return String(n).padStart(2, "0"); }
  // Same day key as storage.js: the local calendar day.
  function dayKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function fmtDay(d, withYear) { return d.getDate() + " " + MONTHS[d.getMonth()] + (withYear ? " " + d.getFullYear() : ""); }
  function fmtWhen(t) {
    var d = new Date(t), now = new Date();
    var time = d.getHours() + ":" + pad2(d.getMinutes());
    if (dayKey(d) === dayKey(now)) return "сегодня в " + time;
    if (dayKey(d) === dayKey(addDays(now, -1))) return "вчера в " + time;
    return fmtDay(d, d.getFullYear() !== now.getFullYear());
  }
  // The later of the two dates: last edit if there was one, otherwise creation.
  function whenLine(item) {
    var edited = item.updatedAt - item.createdAt > 60 * 1000;
    var t = edited ? item.updatedAt : item.createdAt;
    return h("div", { class: "when", title: new Date(t).toLocaleString("ru-RU") }, (edited ? "Изменён " : "Создан ") + fmtWhen(t));
  }

  /* ---------- profile ---------- */
  function initials(name) {
    var words = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "";
    var first = function (w) { return Array.from(w)[0]; };
    return (words.length > 1 ? first(words[0]) + first(words[1]) : first(words[0])).toUpperCase();
  }
  // Shows the picture, or the first letters of the nickname, or a person icon when there is neither.
  function fillAvatar(el, src, name) {
    var key = src ? "img:" + src : "txt:" + initials(name);
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    if (src) el.replaceChildren(h("img", { src: src, alt: "", draggable: "false" }));
    else if (initials(name)) el.textContent = initials(name);
    else el.innerHTML = ICONS.user;
  }
  function displayName() { return (state.profile && state.profile.name) || "Без ника"; }

  var toastTimer = null;
  function toast(msg, long) {
    var host = document.querySelector("dialog[open]") || document.body;
    if (els.toast.parentNode !== host) host.appendChild(els.toast);
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove("show"); }, long ? 5200 : 2400);
  }
  // action: optional { label, onclick } for a button next to the text, { close, onclose } for the close link.
  var bannerOnClose = null;
  function showBanner(text, action) {
    els.bannerText.textContent = text;
    // action.percent: a download bar under the text
    if (action && typeof action.percent === "number") {
      var fill = h("span");
      fill.style.width = Math.max(0, Math.min(100, action.percent)) + "%";
      els.bannerText.append(h("span", { class: "banner-bar" }, fill));
    }
    els.bannerAction.hidden = !(action && action.label);
    els.bannerAction.textContent = (action && action.label) || "";
    els.bannerAction.onclick = (action && action.onclick) || null;
    els.bannerClose.textContent = (action && action.close) || "Понятно";
    bannerOnClose = (action && action.onclose) || null;
    els.banner.hidden = false;
  }

  /* ---------- talking to the disk ---------- */
  function setItems(prompts) {
    state.items = (prompts || []).map(function (p) {
      return {
        id: p.id, title: p.title || "", type: p.type || "", text: p.text || "", comment: p.comment || "",
        createdAt: p.createdAt || 0, updatedAt: p.updatedAt || 0,
        files: Array.isArray(p.files) ? p.files : []
      };
    });
  }
  function applyData(r) {
    if (r.prompts) setItems(r.prompts);
    if (r.info) state.info = r.info;
    if (r.profile) state.profile = r.profile;
    if (r.activity) state.activity = r.activity;
    if (r.events) state.events = r.events;
    if (r.tasks) state.tasks = r.tasks;
  }
  // Every call returns { ok, prompts?, error? }. Fresh prompts replace the list.
  function call(promise) {
    return Promise.resolve(promise).then(function (r) {
      if (!r || !r.ok) {
        toast((r && r.error) || "Не получилось. Попробуйте ещё раз.", true);
        return null;
      }
      applyData(r);
      return r;
    }, function () {
      toast("Не получилось. Попробуйте ещё раз.", true);
      return null;
    });
  }

  /* ---------- copy ---------- */
  function markCopied(btn) {
    var label = btn.querySelector(".lbl");
    btn.classList.add("done");
    btn.replaceChild(icon("check"), btn.firstChild);
    label.textContent = "Скопировано";
    clearTimeout(btn._t);
    btn._t = setTimeout(function () {
      btn.classList.remove("done");
      btn.replaceChild(icon("copy"), btn.firstChild);
      label.textContent = "Копировать";
    }, 1800);
  }
  function copyPrompt(item, btn) {
    api.copyText(item.text, item.id).then(function (r) {
      if (r && r.ok) {
        markCopied(btn);
        // Only the profile counters change: re-rendering the rows would reset the "Скопировано" button.
        if (r.activity) { state.activity = r.activity; renderChrome(); }
      } else toast("Не получилось скопировать. Выделите текст и нажмите Ctrl + C.");
    }, function () { toast("Не получилось скопировать. Выделите текст и нажмите Ctrl + C."); });
  }

  /* ---------- expand / collapse ---------- */
  function expand(id, value) {
    if (value) state.expanded.add(id); else state.expanded.delete(id);
    var box = document.getElementById("pt-" + id);
    if (!box) return;
    box.classList.toggle("is-collapsed", !value);
    var btn = box.parentNode.querySelector(".toggle");
    if (btn) {
      btn.setAttribute("aria-expanded", String(!!value));
      btn.querySelector(".lbl").textContent = value ? "Свернуть" : "Развернуть";
    }
  }
  function measure() {
    var list = els.rows.querySelectorAll(".prompt");
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var t = p.querySelector(".prompt-text");
      var wasOpen = !t.classList.contains("is-collapsed");
      if (wasOpen) t.classList.add("is-collapsed");
      var over = t.scrollHeight > t.clientHeight + 4;
      if (wasOpen) t.classList.remove("is-collapsed");
      p.classList.toggle("can-toggle", over);
      // A comment longer than three lines folds; a short one stays as it is.
      var n = p.querySelector(".prompt-note");
      if (!n) continue;
      var noteOpen = n.classList.contains("open");
      if (noteOpen) n.classList.remove("open");
      var nt = n.querySelector(".prompt-note-text");
      var noteOver = nt.scrollHeight > nt.clientHeight + 4;
      if (noteOpen) n.classList.add("open");
      n.classList.toggle("can-toggle", noteOver);
      if (noteOver) { n.setAttribute("role", "button"); n.tabIndex = 0; n.setAttribute("aria-expanded", String(noteOpen)); }
      else { n.removeAttribute("role"); n.removeAttribute("tabindex"); n.removeAttribute("aria-expanded"); }
    }
  }
  var measureQueued = false;
  function queueMeasure() {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(function () { measureQueued = false; measure(); });
  }

  /* ---------- file tiles ---------- */
  // Tiles are reused between renders so videos and images don't reload while you type in search.
  var tileCache = new Map();

  function docTile(name, cls) {
    var ext = extOf(name) || "файл";
    return [h("span", { class: "ext " + (cls || ""), text: ext.slice(0, 5) }), h("span", { class: "fname", text: name })];
  }
  function fillTile(btn, file, url) {
    btn.replaceChildren();
    btn.classList.remove("doc");
    var kind = file.kind || kindOf(file.name);
    var fallback = function () { btn.classList.add("doc"); btn.replaceChildren.apply(btn, docTile(file.name)); };
    if (kind === "image" && url) {
      var img = h("img", { alt: "", loading: "lazy", decoding: "async", draggable: "false" });
      img.addEventListener("error", fallback, { once: true });
      img.src = url;
      btn.append(img);
    } else if (kind === "video" && url) {
      var v = h("video", { muted: true, preload: "metadata", playsinline: true, disablepictureinpicture: true });
      v.muted = true;
      v.addEventListener("error", fallback, { once: true });
      v.src = url + "#t=0.1";
      btn.append(v, h("span", { class: "play", html: ICONS.play, "aria-hidden": "true" }));
    } else {
      fallback();
    }
  }
  function rowTile(item, file) {
    var key = item.id + "|" + file.id + "|" + file.url;
    var btn = tileCache.get(key);
    if (!btn) {
      btn = h("button", { type: "button", class: "tile" });
      fillTile(btn, file, file.url);
      tileCache.set(key, btn);
    }
    btn.title = file.name + (file.size ? " · " + fmtSize(file.size) : "");
    btn.setAttribute("aria-label", "Файл " + file.name);
    btn.onclick = function () { openViewer(item.id, file.id); };
    return btn;
  }

  /* ---------- viewer ---------- */
  var viewerState = null;
  function openViewer(promptId, fileId) {
    var item = findItem(promptId);
    if (!item) return;
    var idx = item.files.findIndex(function (f) { return f.id === fileId; });
    if (idx === -1) return;
    var file = item.files[idx];
    if (file.kind !== "image" && file.kind !== "video" && file.kind !== "audio") {
      call(api.openFile(promptId, fileId));
      return;
    }
    viewerState = { promptId: promptId, index: idx };
    renderViewer();
    if (!els.viewer.open) els.viewer.showModal();
  }
  function renderViewer() {
    var item = viewerState && findItem(viewerState.promptId);
    if (!item || !item.files.length) { closeViewer(); return; }
    if (viewerState.index >= item.files.length) viewerState.index = item.files.length - 1;
    var file = item.files[viewerState.index];
    els.viewerTitle.replaceChildren(file.name, h("span", { class: "muted", text: [item.title, fmtSize(file.size)].filter(Boolean).join(" · ") }));
    var media;
    if (file.kind === "image") media = h("img", { src: file.url, alt: file.name });
    else if (file.kind === "video") { media = h("video", { src: file.url, controls: true, autoplay: true }); }
    else if (file.kind === "audio") media = h("audio", { src: file.url, controls: true, autoplay: true });
    else media = h("div", { class: "viewer-doc" }, h("span", { class: "ext", text: extOf(file.name) || "файл" }), h("span", { text: file.name }));
    if (media.tagName === "IMG" || media.tagName === "VIDEO") {
      media.addEventListener("error", function () {
        media.replaceWith(h("div", { class: "viewer-doc" }, h("span", { class: "ext", text: extOf(file.name) || "файл" }),
          h("span", { text: "Здесь этот файл не показать. Откройте его в программе." })));
      }, { once: true });
    }
    var kids = [media];
    if (item.files.length > 1) {
      kids.push(h("button", { type: "button", class: "viewer-nav prev", "aria-label": "Предыдущий файл", html: ICONS.left, onclick: function () { stepViewer(-1); } }));
      kids.push(h("button", { type: "button", class: "viewer-nav next", "aria-label": "Следующий файл", html: ICONS.right, onclick: function () { stepViewer(1); } }));
    }
    els.viewerBody.replaceChildren.apply(els.viewerBody, kids);
  }
  function stepViewer(d) {
    var item = viewerState && findItem(viewerState.promptId);
    if (!item) return;
    viewerState.index = (viewerState.index + d + item.files.length) % item.files.length;
    renderViewer();
  }
  function closeViewer() {
    els.viewerBody.replaceChildren();
    viewerState = null;
    if (els.viewer.open) els.viewer.close();
  }
  function viewerFile() {
    var item = viewerState && findItem(viewerState.promptId);
    return item ? { promptId: item.id, file: item.files[viewerState.index] } : null;
  }
  els.viewerClose.addEventListener("click", closeViewer);
  els.viewer.addEventListener("close", function () { els.viewerBody.replaceChildren(); viewerState = null; });
  els.viewer.addEventListener("click", function (e) { if (e.target === els.viewer) closeViewer(); });
  els.viewer.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") { e.preventDefault(); stepViewer(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stepViewer(1); }
  });
  els.viewerOpen.addEventListener("click", function () { var v = viewerFile(); if (v) call(api.openFile(v.promptId, v.file.id)); });
  els.viewerShow.addEventListener("click", function () { var v = viewerFile(); if (v) call(api.showFile(v.promptId, v.file.id)); });

  /* ---------- incoming files (drop, paste, picker) ---------- */
  function pastedName(file, i) {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, "0"); };
    var ext = (file.type && file.type.split("/")[1]) || "png";
    if (ext === "jpeg") ext = "jpg";
    return "Вставка " + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
      pad(d.getHours()) + "-" + pad(d.getMinutes()) + "-" + pad(d.getSeconds()) + (i ? " " + (i + 1) : "") + "." + ext.replace(/[^a-z0-9]/gi, "");
  }
  // Turns File objects into sources main.js can copy: a disk path when there is one, bytes otherwise.
  function filesToSources(fileList, pasted) {
    var files = Array.prototype.slice.call(fileList || []);
    return Promise.all(files.map(function (file, i) {
      var p = api.pathForFile(file);
      var name = pasted || !file.name ? pastedName(file, i) : file.name;
      if (p) return { source: { path: p, name: file.name || name }, name: file.name || name, size: file.size, preview: file };
      return file.arrayBuffer().then(function (buf) {
        return { source: { name: name, data: new Uint8Array(buf) }, name: name, size: file.size, preview: file };
      }, function () { return null; });
    })).then(function (list) { return list.filter(Boolean); });
  }

  function attachToPrompt(promptId, sources) {
    if (!sources.length) return;
    var item = findItem(promptId);
    toast(sources.length > 1 ? "Прикрепляю файлы…" : "Прикрепляю файл…");
    call(api.addFiles(promptId, sources)).then(function (r) {
      if (!r) return;
      render();
      if (r.errors && r.errors.length) toast("Не получилось прикрепить: " + r.errors.join(", "), true);
      else toast(r.added > 1 ? "Прикреплено файлов: " + r.added + (item ? " → «" + item.title + "»" : "") : "Файл прикреплён" + (item ? " → «" + item.title + "»" : ""));
    });
  }
  function pickForPrompt(item) {
    api.pickFiles().then(function (r) {
      if (!r || !r.ok || !r.files.length) return;
      attachToPrompt(item.id, r.files.map(function (f) { return { path: f.path, name: f.name }; }));
    });
  }

  /* ---------- editor ---------- */
  function buildCategoryPicker() {
    els.fCat.replaceChildren.apply(els.fCat, CATEGORIES.map(function (c) {
      return h("label", { class: "cat-option " + c.cls },
        h("input", { type: "radio", name: "f-cat", id: "f-cat-" + c.cls, value: c.label }),
        h("span", { text: c.label }));
    }));
  }
  function setCategory(type) {
    var c = categoryOf(type);
    var inputs = els.fCat.querySelectorAll("input");
    for (var i = 0; i < inputs.length; i++) inputs[i].checked = !!c && inputs[i].value === c.label;
  }
  function selectedCategory() {
    var checked = els.fCat.querySelector("input:checked");
    return checked ? checked.value : "";
  }
  function setMsg(text, neutral) {
    els.formMsg.textContent = text || "";
    els.formMsg.classList.toggle("neutral", !!neutral);
  }
  function releaseDraft() {
    if (!state.draft) return;
    state.draft.pending.forEach(function (p) { if (p.url && p.url.indexOf("blob:") === 0) URL.revokeObjectURL(p.url); });
    state.draft = null;
  }
  function renderEditorFiles() {
    var d = state.draft;
    if (!d) { els.fFiles.replaceChildren(); return; }
    var tiles = [];
    d.existing.forEach(function (f) {
      if (d.removed.has(f.id)) return;
      var t = h("span", { class: "tile tile-static", title: f.name + (f.size ? " · " + fmtSize(f.size) : "") });
      fillTile(t, f, f.url);
      tiles.push(h("span", { class: "tile-wrap" }, t,
        h("button", { type: "button", class: "tile-remove", "aria-label": "Убрать файл " + f.name, html: ICONS.x,
          onclick: function () { d.removed.add(f.id); renderEditorFiles(); } })));
    });
    d.pending.forEach(function (p, idx) {
      var t = h("span", { class: "tile tile-new", title: p.name + (p.size ? " · " + fmtSize(p.size) : "") });
      fillTile(t, { name: p.name, kind: kindOf(p.name) }, p.url);
      tiles.push(h("span", { class: "tile-wrap" }, t,
        h("button", { type: "button", class: "tile-remove", "aria-label": "Убрать файл " + p.name, html: ICONS.x,
          onclick: function () {
            if (p.url && p.url.indexOf("blob:") === 0) URL.revokeObjectURL(p.url);
            d.pending.splice(idx, 1);
            renderEditorFiles();
          } })));
    });
    tiles.push(h("button", { type: "button", class: "tile-add", onclick: pickForDraft }, icon("plus"), h("span", { text: "Добавить" })));
    els.fFiles.replaceChildren.apply(els.fFiles, tiles);
  }
  function addToDraft(list) {
    if (!state.draft) return;
    list.forEach(function (p) {
      if (!p.url && p.preview) p.url = URL.createObjectURL(p.preview);
      delete p.preview;
      state.draft.pending.push(p);
    });
    renderEditorFiles();
  }
  function pickForDraft() {
    api.pickFiles().then(function (r) {
      if (!r || !r.ok || !r.files.length) return;
      addToDraft(r.files.map(function (f) { return { source: { path: f.path, name: f.name }, name: f.name, size: f.size, url: f.url }; }));
    });
  }

  // focusComment: opened from the "Комментарий" button, so the cursor goes straight to the comment.
  function openEditor(item, focusComment) {
    if (state.editorOpen && state.editingId !== (item ? item.id : null) && editorDirty()) {
      // Moving to another prompt keeps nothing unsaved by accident: ask first.
      setMsg("Сначала сохраните или отмените текущую правку.");
      try { els.editor.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" }); } catch (e) {}
      return;
    }
    releaseDraft();
    state.editorOpen = true;
    state.editingId = item ? item.id : null;
    state.confirmId = null;
    state.draft = { existing: item ? item.files.slice() : [], removed: new Set(), pending: [] };
    els.editor.classList.toggle("inline", !!item);
    els.editorTitle.textContent = item ? "Редактирование" : "Новый промт";
    els.fTitle.value = item ? item.title : "";
    els.fText.value = item ? item.text : "";
    els.fComment.value = item ? item.comment : "";
    if (item) setCategory(item.type);
    else {
      var filtered = state.type !== "all" ? categoryOf(state.type) : null;
      setCategory(filtered ? filtered.label : CATEGORIES[0].label);
    }
    els.editor.dataset.snapshot = snapshot();
    setMsg("");
    els.editor.hidden = false;
    renderEditorFiles();
    render();
    try { els.editor.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" }); } catch (e) {}
    (focusComment ? els.fComment : item ? els.fText : els.fTitle).focus({ preventScroll: true });
  }
  function snapshot() { return JSON.stringify([els.fTitle.value, els.fText.value, els.fComment.value, selectedCategory()]); }
  function editorDirty() {
    if (!state.editorOpen) return false;
    var d = state.draft;
    return snapshot() !== els.editor.dataset.snapshot || (d && (d.pending.length || d.removed.size));
  }
  function closeEditor(restoreFocus) {
    var wasId = state.editingId;
    state.editorOpen = false;
    state.editingId = null;
    releaseDraft();
    els.editor.hidden = true;
    els.editor.classList.remove("inline", "drop-over");
    setMsg("");
    render();
    if (restoreFocus) {
      var target = wasId ? els.rows.querySelector('tr[data-id="' + wasId + '"] .edit-btn') : els.addBtn;
      if (target && !target.hidden) target.focus({ preventScroll: true });
    }
  }
  function submitEditor(e) {
    e.preventDefault();
    if (els.saveBtn.disabled) return;
    var title = els.fTitle.value.trim();
    var type = selectedCategory();
    var text = els.fText.value.replace(/\s+$/, "");
    if (!title) { setMsg("Добавьте название, чтобы промт было легко найти."); els.fTitle.focus(); return; }
    if (!type) { setMsg("Выберите тип: Статика, Видео или Системные."); var first = els.fCat.querySelector("input"); if (first) first.focus(); return; }
    if (!text.trim()) { setMsg("Вставьте текст промта."); els.fText.focus(); return; }
    var existing = state.editingId ? findItem(state.editingId) : null;
    var d = state.draft || { pending: [], removed: new Set() };
    var payload = {
      item: { id: existing ? existing.id : newId(), title: title, type: type, text: text, comment: els.fComment.value.trim() },
      addFiles: d.pending.map(function (p) { return p.source; }),
      removeFileIds: Array.from(d.removed)
    };
    els.saveBtn.disabled = true;
    setMsg(payload.addFiles.length ? "Сохраняю и копирую файлы…" : "Сохраняю…", true);
    call(api.savePrompt(payload)).then(function (r) {
      els.saveBtn.disabled = false;
      if (!r) { setMsg("Не сохранилось. Попробуйте ещё раз."); return; }
      var saved = findItem(r.id);
      if (saved && !matches(saved)) { state.type = "all"; state.query = ""; els.search.value = ""; }
      closeEditor(false);
      if (r.errors && r.errors.length) toast("Промт сохранён, но не получилось прикрепить: " + r.errors.join(", "), true);
      else toast(existing ? "Изменения сохранены" : "Промт добавлен");
    });
  }

  function removeItem(id) {
    var item = findItem(id);
    var hadFiles = item && item.files.length;
    call(api.deletePrompt(id)).then(function (r) {
      state.confirmId = null;
      if (!r) { render(); return; }
      state.expanded.delete(id);
      if (state.editingId === id) closeEditor(false); else render();
      toast(hadFiles ? "Промт удалён, его файлы перемещены в Корзину" : "Промт удалён");
    });
  }

  // Keeps the one editor form in the right place (top panel or inside the row) without losing what was typed.
  function placeEditor() {
    var target = state.editingId ? document.getElementById("edit-cell") : els.editorSlot;
    if (!target || els.editor.parentNode === target) return;
    target.appendChild(els.editor);
  }
  function captureFocus() {
    var a = document.activeElement;
    if (!a || !els.editor.contains(a)) return null;
    var info = { el: a };
    try { if (typeof a.selectionStart === "number") { info.s = a.selectionStart; info.e = a.selectionEnd; } } catch (e) {}
    return info;
  }
  function restoreFocus(info) {
    if (!info || document.activeElement === info.el) return;
    try {
      info.el.focus({ preventScroll: true });
      if (typeof info.s === "number") info.el.setSelectionRange(info.s, info.e);
    } catch (e) {}
  }

  /* ---------- render ---------- */
  function typeStats() {
    var map = new Map();
    CATEGORIES.forEach(function (c) { map.set(c.key, { key: c.key, label: c.label, cls: c.cls, count: 0 }); });
    state.items.forEach(function (i) {
      var k = norm(i.type);
      if (!k) return;
      if (!map.has(k)) map.set(k, { key: k, label: i.type.trim(), cls: "cat-other", count: 0 });
      map.get(k).count++;
    });
    return Array.from(map.values());
  }

  function typeChip(type) {
    return h("button", {
      type: "button", class: "chip " + catClass(type), title: "Показать только «" + type + "»",
      onclick: function () { state.type = norm(type); render(); }
    }, type);
  }

  function actions(item) {
    if (state.confirmId === item.id) {
      return h("div", { class: "row-actions confirm" },
        h("span", { text: item.files.length ? "Удалить промт и его файлы?" : "Удалить промт?" }),
        h("button", { type: "button", class: "link-btn danger", onclick: function () { removeItem(item.id); } }, "Удалить"),
        h("button", { type: "button", class: "link-btn", onclick: function () { state.confirmId = null; render(); } }, "Отмена")
      );
    }
    return h("div", { class: "row-actions" },
      h("button", { type: "button", class: "btn-mini edit-btn", onclick: function () { openEditor(item); } },
        icon("pencil"), h("span", { text: "Редактировать" })),
      h("button", { type: "button", class: "btn-mini", title: "Сохранить промт с комментарием и файлами в файл, чтобы отправить другу",
        onclick: function () { exportPrompts([item.id]); } }, icon("share"), h("span", { text: "Поделиться" })),
      h("button", { type: "button", class: "link-btn", onclick: function () { state.confirmId = item.id; render(); } }, "Удалить")
    );
  }

  function promptBlock(item) {
    var open = state.expanded.has(item.id);
    var box = h("div", { class: "prompt-text" + (open ? "" : " is-collapsed"), id: "pt-" + item.id }, item.text);
    box.addEventListener("click", function () {
      var wrap = box.parentNode;
      if (!wrap.classList.contains("can-toggle") || !box.classList.contains("is-collapsed")) return;
      var sel = window.getSelection && window.getSelection();
      if (sel && String(sel).length) return;
      expand(item.id, true);
    });
    var toggle = h("button", {
      type: "button", class: "btn-mini toggle", "aria-expanded": String(open), "aria-controls": "pt-" + item.id,
      onclick: function () { expand(item.id, !state.expanded.has(item.id)); }
    }, icon("chevron"), h("span", { class: "lbl", text: open ? "Свернуть" : "Развернуть" }));
    var note = h("button", { type: "button", class: "btn-mini", title: item.comment ? "Изменить комментарий" : "Добавить комментарий к промту", onclick: function () { openEditor(item, true); } },
      icon("note"), h("span", { text: "Комментарий" }));
    var attach = h("button", { type: "button", class: "btn-mini", title: "Прикрепить файлы к этому промту", onclick: function () { pickForPrompt(item); } },
      icon("clip"), h("span", { text: "Файл" }));
    var copy = h("button", {
      type: "button", class: "btn-mini copy", "aria-label": "Копировать промт «" + item.title + "»",
      onclick: function (e) { copyPrompt(item, e.currentTarget); }
    }, icon("copy"), h("span", { class: "lbl", text: "Копировать" }));
    var count = item.text.length;
    var files = item.files.length ? h("div", { class: "files" }, item.files.map(function (f) { return rowTile(item, f); })) : null;
    var comment = item.comment ? commentBlock(item) : null;
    return h("div", { class: "prompt" }, box, comment,
      h("div", { class: "prompt-bar" }, toggle,
        h("span", { class: "chars", text: fmtNum(count) + " " + plural(count, "символ", "символа", "символов") }),
        h("span", { class: "spacer" }), note, attach, copy),
      files);
  }

  // Shows three lines of the comment; a click (or Enter) opens the rest and closes it again.
  function commentBlock(item) {
    var el = h("div", { class: "prompt-note" + (state.notesOpen.has(item.id) ? " open" : ""), title: "Нажмите, чтобы развернуть или свернуть комментарий" },
      icon("note"), h("div", { class: "prompt-note-text", text: item.comment }));
    var toggleNote = function () {
      if (!el.classList.contains("can-toggle")) return;
      var open = !state.notesOpen.has(item.id);
      if (open) state.notesOpen.add(item.id); else state.notesOpen.delete(item.id);
      el.classList.toggle("open", open);
      el.setAttribute("aria-expanded", String(open));
    };
    el.addEventListener("click", function () {
      var sel = window.getSelection && window.getSelection();
      if (sel && String(sel).length) return;   // selecting text to copy it should not fold the comment
      toggleNote();
    });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleNote(); }
    });
    return el;
  }

  function row(item) {
    if (item.id === state.editingId) {
      return h("tr", { class: "editing", "data-id": item.id }, h("td", { colspan: "3", id: "edit-cell" }));
    }
    return h("tr", { "data-id": item.id, class: state.dropRowId === item.id ? "drop-target" : null },
      h("td", { class: "c-name" },
        h("div", { class: "name", text: item.title || "Без названия" }),
        whenLine(item),
        actions(item)),
      h("td", { class: "c-type" }, item.type ? typeChip(item.type) : h("span", { class: "muted", text: "—" })),
      h("td", { class: "c-prompt" }, promptBlock(item))
    );
  }

  function setState(title, text, button) {
    els.stateBox.replaceChildren(
      h("div", { class: "dots", "aria-hidden": "true" }, CATEGORIES.map(function (c) { return h("i", { class: c.cls }); })),
      h("h2", { text: title }),
      h("p", { text: text }),
      button || null
    );
    els.stateBox.hidden = false;
    els.table.hidden = true;
  }

  function render() {
    var focus = captureFocus();
    var loading = !state.loaded;
    var total = state.items.length;
    var stats = typeStats();

    if (state.editingId && !findItem(state.editingId)) {
      state.editingId = null;
      state.editorOpen = false;
      releaseDraft();
      els.editor.hidden = true;
      els.editor.classList.remove("inline");
      toast("Этот промт удалили, пока вы его редактировали");
    }

    els.addBtn.hidden = loading;
    if (loading) els.meta.textContent = "Загружаю промты…";
    else if (!total) els.meta.textContent = "Пока ни одного промта";
    else els.meta.textContent = fmtNum(total) + " " + plural(total, "промт", "промта", "промтов") + " · " +
      stats.filter(function (s) { return s.count; }).map(function (s) { return s.label + " " + s.count; }).join(" · ");

    if (state.type !== "all" && !stats.some(function (s) { return s.key === state.type; })) state.type = "all";
    els.toolbar.hidden = loading || total === 0;
    var chips = [h("button", {
      type: "button", class: "fchip", "aria-pressed": String(state.type === "all"),
      onclick: function () { state.type = "all"; render(); }
    }, "Все", h("span", { class: "n", text: String(total) }))];
    stats.forEach(function (s) {
      chips.push(h("button", {
        type: "button", class: "fchip " + s.cls, "aria-pressed": String(state.type === s.key),
        onclick: function () { state.type = state.type === s.key ? "all" : s.key; render(); }
      }, h("span", { class: "dot", "aria-hidden": "true" }), s.label, h("span", { class: "n", text: String(s.count) })));
    });
    els.filters.replaceChildren.apply(els.filters, chips);

    if (state.info) {
      els.setDir.replaceChildren(h("span", { class: "ico", html: ICONS.folder, "aria-hidden": "true" }), h("code", { text: state.info.dataDir }));
      markTheme(state.info.theme);
      renderAssistantSettings();
    }

    if (loading) {
      setState("Загружаю промты…", "Сейчас здесь появится ваша таблица.");
    } else if (!total) {
      setState("Здесь пока пусто",
        "Добавьте первый промт из урока: название, тип и сам текст. Длинный текст свернётся, а скопировать его можно одной кнопкой.",
        !state.editorOpen ? h("button", { type: "button", class: "btn btn-primary", onclick: function () { openEditor(null); } }, "Добавить первый промт") : null);
    } else {
      var visible = sortItems(state.items).filter(function (i) { return matches(i) || i.id === state.editingId; });
      if (!visible.length) {
        setState("Ничего не нашлось", "Попробуйте другое слово или сбросьте фильтр по типу.",
          h("button", { type: "button", class: "btn btn-ghost", onclick: function () {
            state.type = "all"; state.query = ""; els.search.value = ""; render(); els.search.focus();
          } }, "Сбросить поиск"));
      } else {
        els.stateBox.hidden = true;
        els.table.hidden = false;
        els.rows.replaceChildren.apply(els.rows, visible.map(row));
        queueMeasure();
      }
    }

    placeEditor();
    restoreFocus(focus);
    if (viewerState) renderViewerIfChanged();
    renderChrome();
    if (state.page === "stats") renderStats();
    if (state.page === "calendar") renderCalendar();
    if (state.page === "tasks") renderTasks();
  }

  /* ---------- tabs ---------- */
  // Like a browser: every section opens in a tab on top of the window. Prompts, calendar, tasks, generator and statistics
  // open once (opening again switches to that tab); LLM tabs open as many times as needed, each with its own conversation.
  // A tab: { id, kind, session? (LLM), usedAt }. The list and the open tab are kept in settings.json (set-tabs).
  var TABS = {
    home: { name: "Главная", icon: "home" },
    prompts: { name: "Промты", icon: "prompts" },
    calendar: { name: "Календарь", icon: "calendar" },
    tasks: { name: "Задачи", icon: "tasks", alpha: true },
    assistant: { name: "LLM", icon: "chat", many: true },
    generator: { name: "Генератор", icon: "spark" },
    stats: { name: "Статистика", icon: "stats" }
  };
  var TAB_ORDER = ["home", "prompts", "calendar", "tasks", "assistant", "generator", "stats"];
  var tabs = { list: [], active: -1, seq: 0 };
  function activeTab() { return tabs.list[tabs.active] || null; }
  function chatTitle(id) { var c = hist.list.find(function (x) { return x.id === id; }); return c ? c.title : ""; }
  function tabTitle(t) {
    if (t.kind !== "assistant") return TABS[t.kind].name;
    var se = t.session;
    return "LLM · " + (se.title || (se.loadId && chatTitle(se.loadId)) || "Новый разговор");
  }
  function makeTab(kind, session) {
    var t = { id: ++tabs.seq, kind: kind, usedAt: 0 };
    if (kind === "assistant") t.session = session || newSession(false);
    return t;
  }
  // opts: fresh — a new LLM conversation even if one is open; session — show this conversation in a new tab;
  // background — open without switching to it.
  function openTab(kind, opts) {
    opts = opts || {};
    if (!TABS[kind]) return;
    var at = -1;
    if (!TABS[kind].many) at = tabs.list.findIndex(function (t) { return t.kind === kind; });
    else if (!opts.fresh && !opts.session) {
      var cur = activeTab();
      if (cur && cur.kind === kind) at = tabs.active;
      else tabs.list.forEach(function (t, i) {
        if (t.kind !== kind) return;
        var better = at === -1 || (t.session && t.session.unread) && !(tabs.list[at].session && tabs.list[at].session.unread) ||
          !!(t.session && t.session.unread) === !!(tabs.list[at].session && tabs.list[at].session.unread) && t.usedAt > tabs.list[at].usedAt;
        if (better) at = i;
      });
    }
    if (at === -1) { tabs.list.push(makeTab(kind, opts.session)); at = tabs.list.length - 1; }
    if (opts.background) { renderTabs(); saveTabs(); return; }
    activateTab(at);
  }
  function activateTab(i) {
    var t = tabs.list[i];
    if (!t) return;
    setMenu(false);
    setTabMenu(false);
    tabs.active = i;
    t.usedAt = Date.now();
    state.page = t.kind;
    if (t.kind === "assistant") showSession(t.session);
    els.scroller.scrollTop = 0;
    render();
    saveTabs();
    if (t.kind === "assistant") { scrollChat(); els.chatInput.focus({ preventScroll: true }); }
  }
  // Closing a tab with an answer being written stops the answer, like closing a page in a browser.
  function closeTab(i) {
    var t = tabs.list[i];
    if (!t) return;
    if (t.session) {
      if (t.session.current) stopChat(t.session);
      persist(t.session);
      dropSession(t.session);
    }
    tabs.list.splice(i, 1);
    if (!tabs.list.length) { tabs.list.push(makeTab("home")); activateTab(0); return; }
    if (i === tabs.active) activateTab(Math.min(i, tabs.list.length - 1));
    else { if (i < tabs.active) tabs.active--; renderTabs(); saveTabs(); }
  }
  function saveTabs() {
    api.setTabs({
      list: tabs.list.map(function (t) { return t.kind === "assistant" ? { kind: t.kind, chatId: t.session.id || t.session.loadId || undefined } : { kind: t.kind }; }),
      active: tabs.active
    });
  }
  // The tabs saved last time; an LLM tab loads its conversation when it is first opened.
  function restoreTabs(saved) {
    tabs.list = [];
    (saved && saved.list && saved.list.length ? saved.list : [{ kind: "prompts" }]).forEach(function (x) {
      if (!TABS[x.kind]) return;
      var t = makeTab(x.kind);
      if (t.session && x.chatId) t.session.loadId = x.chatId;
      tabs.list.push(t);
    });
    if (!tabs.list.length) tabs.list.push(makeTab("prompts"));
    activateTab(Math.max(0, Math.min(tabs.list.length - 1, (saved && saved.active) || 0)));
  }
  function renderTabs() {
    els.tabs.replaceChildren.apply(els.tabs, tabs.list.map(function (t, i) {
      var title = tabTitle(t), on = i === tabs.active;
      return h("div", { class: "tab" + (on ? " on" : ""), role: "tab", "aria-selected": String(on), tabindex: on ? "0" : "-1", title: title,
        onclick: function () { activateTab(i); },
        onauxclick: function (e) { if (e.button === 1) { e.preventDefault(); closeTab(i); } },
        onkeydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activateTab(i); } } },
        h("span", { class: "tab-ico", html: ICONS[TABS[t.kind].icon], "aria-hidden": "true" }),
        h("span", { class: "tab-t", text: title }),
        t.session && t.session.current ? h("span", { class: "tab-busy", title: "Пишет ответ" }) :
          t.session && t.session.unread ? h("span", { class: "tab-unread", title: "Есть новый ответ" }) : null,
        h("button", { type: "button", class: "tab-x", title: "Закрыть вкладку (Ctrl + W)", "aria-label": "Закрыть вкладку «" + title + "»", html: ICONS.x,
          onclick: function (e) { e.stopPropagation(); closeTab(i); } }));
    }));
  }
  // "+": what a new tab shows.
  function setTabMenu(open) {
    els.tabMenu.hidden = !open;
    els.tabPlus.setAttribute("aria-expanded", String(open));
    if (!open) return;
    els.tabMenu.replaceChildren.apply(els.tabMenu, [h("p", { class: "menu-label", text: "Новая вкладка" })].concat(TAB_ORDER.map(function (k) {
      var isOpen = !TABS[k].many && tabs.list.some(function (t) { return t.kind === k; });
      return h("button", { type: "button", role: "menuitem", onclick: function () { setTabMenu(false); openTab(k, { fresh: true }); } },
        h("span", { class: "ico", html: ICONS[TABS[k].icon], "aria-hidden": "true" }),
        h("span", { text: k === "assistant" ? "LLM — новый разговор" : TABS[k].name }),
        isOpen ? h("small", { text: "уже открыта" }) : TABS[k].alpha ? h("small", null, h("span", { class: "alpha", text: "Альфа" })) : null);
    })));
    var r = els.tabPlus.getBoundingClientRect();
    els.tabMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + "px";
    var first = els.tabMenu.querySelector("button");
    if (first) first.focus();
  }
  els.tabPlus.addEventListener("click", function () { setTabMenu(els.tabMenu.hidden); });
  els.tabMenu.addEventListener("keydown", function (e) {
    var items = Array.prototype.slice.call(els.tabMenu.querySelectorAll("button"));
    var i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); setTabMenu(false); els.tabPlus.focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus(); }
  });
  document.addEventListener("mousedown", function (e) {
    if (!els.tabMenu.hidden && !els.tabMenu.contains(e.target) && !els.tabPlus.contains(e.target)) setTabMenu(false);
  });
  // The assistant asked to open tabs ("открой календарь и генератор"): all open, the first one is shown.
  function openTabsFromAssistant(kinds) {
    (kinds || []).forEach(function (k, i) { if (TABS[k]) openTab(k, { fresh: k === "assistant", background: i > 0 }); });
  }

  /* ---------- pages and sidebar ---------- */
  // Every way to a section (sidebar, Ctrl + N, a notification, a card's "Открыть") goes through its tab.
  function setPage(page) {
    setMenu(false);
    var cur = activeTab();
    if (cur && cur.kind === page) return;
    openTab(page);
  }
  function renderChrome() {
    var p = state.profile || {};
    [els.sideAvatar, els.menuAvatar, els.statsAvatar].forEach(function (el) { fillAvatar(el, p.avatar, p.name); });
    els.sideName.textContent = displayName();
    els.menuName.textContent = displayName();
    var year = activityStats().year;
    els.menuSub.textContent = fmtNum(year) + " " + plural(year, "действие", "действия", "действий") + " за год";
    els.navItems.forEach(function (b) {
      if (b.dataset.page === state.page) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    Object.keys(els.views).forEach(function (k) { els.views[k].hidden = k !== state.page; });
    renderTabs();
    renderUpcoming();
    renderBadges();
    if (state.page === "home") renderHome();
  }

  // The small counters on the section icons: what is left for today, tasks not done yet, answers not read yet.
  function badgeCounts() {
    var now = new Date(), today = dayKey(now), mins = now.getHours() * 60 + now.getMinutes();
    return {
      calendar: (state.events || []).filter(function (e) { return e.date === today && (e.to ? minutesOf(e.to) : minutesOf(e.from) + 30) > mins; }).length,
      tasks: (state.tasks || []).filter(function (t) { return t.status !== "done"; }).length,
      assistant: sessions.filter(function (se) { return se.unread; }).length,
      generator: 0
    };
  }
  function renderBadges() {
    var n = badgeCounts();
    els.badges.forEach(function (b) {
      var v = n[b.dataset.badge] || 0;
      b.hidden = !v;
      b.textContent = v > 9 ? "9+" : String(v);
    });
  }
  // Home: a greeting and a tile for every section with what is there now.
  function renderHome() {
    var hr = new Date().getHours(), name = state.profile && state.profile.name;
    els.homeTitle.textContent = (hr < 5 ? "Доброй ночи" : hr < 12 ? "Доброе утро" : hr < 18 ? "Добрый день" : "Добрый вечер") + (name ? ", " + name : "") + "!";
    els.homeDate.textContent = longDay(dayKey(new Date()));
    var n = badgeCounts(), items = state.items.length, doing = (state.tasks || []).filter(function (t) { return t.status === "doing"; }).length;
    var tiles = [
      { page: "prompts", title: "Промты", text: items ? items + " " + plural(items, "промт", "промта", "промтов") + " в базе" : "Пока пусто: добавьте первый" },
      { page: "calendar", title: "Календарь", text: n.calendar ? "Сегодня ещё " + n.calendar + " " + plural(n.calendar, "дело", "дела", "дел") : "На сегодня дел больше нет" },
      { page: "tasks", title: "Задачи", text: n.tasks ? n.tasks + " " + plural(n.tasks, "задача не готова", "задачи не готовы", "задач не готово") + (doing ? ", в процессе " + doing : "") : "Все задачи готовы" },
      { page: "assistant", title: "LLM", text: n.assistant ? "Новых ответов: " + n.assistant : hist.list.length + " " + plural(hist.list.length, "разговор", "разговора", "разговоров") + " в истории" },
      { page: "generator", title: "Генератор", text: "Картинки и видео — скоро" }
    ];
    els.homeGrid.replaceChildren.apply(els.homeGrid, tiles.map(function (t) {
      return h("button", { type: "button", class: "home-tile", onclick: function () { setPage(t.page); } },
        h("span", { class: "ico", html: ICONS[TABS[t.page].icon], "aria-hidden": "true" }), h("b", { text: t.title }), h("span", { text: t.text }));
    }));
  }

  // "Ближайшие дела" in the sidebar: what is going on now and next, by day. The current one pulses in its colour.
  var UP_MAX = 6;
  function renderUpcoming() {
    var now = new Date(), today = dayKey(now), mins = now.getHours() * 60 + now.getMinutes();
    var tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    var list = (state.events || []).filter(function (e) {
      if (e.date !== today) return e.date > today;
      var end = e.to ? minutesOf(e.to) : minutesOf(e.from) + 30;
      return end > mins;
    }).sort(function (a, b) { return (a.date + a.from).localeCompare(b.date + b.from); }).slice(0, UP_MAX);
    var kids = [], lastDay = null;
    list.forEach(function (e) {
      if (e.date !== lastDay) {
        lastDay = e.date;
        var label = e.date === today ? "Сегодня" : e.date === dayKey(tomorrow) ? "Завтра" : shortDayLabel(e.date);
        kids.push(h("p", { class: "up-day", text: label }));
      }
      var on = isNowEvent(e);
      kids.push(h("button", { type: "button", class: "up-ev ev-" + kindOfEvent(e).id + (on ? " now" : ""),
        title: (on ? "Идёт сейчас: " : "") + timeRange(e) + " " + e.title + (e.note ? " — " + e.note : ""), onclick: function () { openCalendarDay(e.date); } },
        h("i", { "aria-hidden": "true" }), h("span", { class: "tt", text: e.title }), h("span", { class: "tm", text: on ? "сейчас" : e.from })));
    });
    if (!kids.length) kids.push(h("p", { class: "up-empty", text: "Ближайших дел нет." }));
    kids.push(h("button", { type: "button", class: "up-more", onclick: function () { setPage("calendar"); } }, "Весь календарь"));
    els.upList.replaceChildren.apply(els.upList, kids);
  }
  function shortDayLabel(k) {
    var d = keyToDate(k);
    return ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][d.getDay()] + ", " + d.getDate() + " " + MONTHS[d.getMonth()];
  }
  setInterval(function () { renderUpcoming(); renderBadges(); }, 30 * 1000);

  /* ---------- statistics ---------- */
  function dayTotal(day) {
    if (!day) return 0;
    return ACTIONS.reduce(function (s, k) { return s + (day[k] || 0); }, 0);
  }
  function heatLevel(n) { return n <= 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 9 ? 3 : 4; }
  function today() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }

  function activityStats() {
    var days = (state.activity && state.activity.days) || {};
    var end = today();
    var res = { year: 0, activeDays: 0, current: 0, best: 0, by: {} };
    ACTIONS.forEach(function (k) { res.by[k] = 0; });
    for (var d = addDays(end, -364); d <= end; d = addDays(d, 1)) {
      var day = days[dayKey(d)], n = dayTotal(day);
      if (!n) continue;
      res.year += n;
      res.activeDays++;
      ACTIONS.forEach(function (k) { res.by[k] += day[k] || 0; });
    }
    // A streak is still alive if today has no actions yet but yesterday had.
    var c = dayTotal(days[dayKey(end)]) ? end : addDays(end, -1);
    while (dayTotal(days[dayKey(c)])) { res.current++; c = addDays(c, -1); }
    var run = 0, prev = null;
    Object.keys(days).filter(function (k) { return dayTotal(days[k]); }).sort().forEach(function (k) {
      var parts = k.split("-");
      var d0 = new Date(+parts[0], +parts[1] - 1, +parts[2]);
      run = prev && dayKey(addDays(prev, 1)) === k ? run + 1 : 1;
      res.best = Math.max(res.best, run);
      prev = d0;
    });
    return res;
  }

  function dayTip(d, day) {
    var n = dayTotal(day);
    var head = fmtDay(d, true) + ", " + WEEKDAYS[(d.getDay() + 6) % 7];
    if (!n) return head + ": нет действий";
    var parts = [];
    if (day.created) parts.push("создано " + day.created);
    if (day.edited) parts.push("правок " + day.edited);
    if (day.files) parts.push("файлов " + day.files);
    if (day.copied) parts.push("скопировано " + day.copied);
    if (day.calendar) parts.push("в календаре " + day.calendar);
    if (day.assistant) parts.push("ассистенту " + day.assistant);
    return head + ": " + n + " " + plural(n, "действие", "действия", "действий") + " (" + parts.join(", ") + ")";
  }

  // 53 weeks, Monday on top, this week in the last column — like the contribution graph on GitHub.
  function renderHeat() {
    var days = (state.activity && state.activity.days) || {};
    var end = today();
    var start = addDays(end, -((end.getDay() + 6) % 7) - 52 * 7);
    var kids = [];
    var place = function (el, col, row) { el.style.gridColumn = String(col); el.style.gridRow = String(row); return el; };
    ["Пн", "", "Ср", "", "Пт", "", ""].forEach(function (l, i) { if (l) kids.push(place(h("span", { class: "w", text: l }), 1, i + 2)); });
    var months = [];
    for (var w = 0; w < 53; w++) {
      var monday = addDays(start, w * 7);
      if (!months.length || months[months.length - 1].month !== monday.getMonth()) months.push({ week: w, month: monday.getMonth() });
      for (var r = 0; r < 7; r++) {
        var d = addDays(monday, r);
        var day = days[dayKey(d)];
        var cell = h("span", { class: "d l" + heatLevel(dayTotal(day)) + (d > end ? " future" : "") });
        if (d <= end) { cell.dataset.tip = dayTip(d, day); cell.title = cell.dataset.tip; }
        kids.push(place(cell, w + 2, r + 2));
      }
    }
    // The first month label is dropped when the next one starts too close to fit both.
    months.forEach(function (m, i) {
      if (i === 0 && months[1] && months[1].week - m.week < 3) return;
      var label = h("span", { class: "m", text: MONTHS_SHORT[m.month] });
      label.style.gridColumn = (m.week + 2) + " / span 3";
      label.style.gridRow = "1";
      kids.push(label);
    });
    els.heat.replaceChildren.apply(els.heat, kids);
  }

  // The page forbids inline style attributes (CSP), so sizes are set through el.style.
  function fillBar(width, label) { var f = h("span", { class: "top-fill", text: label }); f.style.width = width + "%"; return f; }
  // Bars from the most used to the least, like "Desktop usage": share of all actions over the year.
  function renderTopUse(s) {
    var rows = USE_GROUPS.map(function (g) {
      return { g: g, n: g.keys.reduce(function (t, k) { return t + (s.by[k] || 0); }, 0) };
    }).sort(function (a, b) { return b.n - a.n; });
    var total = rows.reduce(function (t, r) { return t + r.n; }, 0);
    if (!total) { els.topList.replaceChildren(h("p", { class: "muted", text: "Пока пусто: здесь появится, чем вы пользуетесь чаще всего." })); return; }
    els.topList.replaceChildren.apply(els.topList, rows.map(function (r) {
      var pct = Math.round(r.n / total * 100);
      return h("div", { class: "top-row" },
        h("span", { class: "top-ico", html: ICONS[r.g.icon], "aria-hidden": "true" }),
        h("span", { class: "top-bar" }, fillBar(Math.max(pct, r.n ? 8 : 0), pct + "%")),
        h("span", { class: "top-name" }, h("b", { text: fmtNum(r.n) }), " " + r.g.name.toLowerCase()));
    }));
  }
  function metric(label, value, sub) {
    return h("div", { class: "metric" }, h("span", { class: "k", text: label }), h("span", { class: "v", text: value }), sub ? h("span", { class: "s", text: sub }) : null);
  }
  function renderStats() {
    var s = activityStats();
    var p = state.profile || {};
    els.statsName.textContent = displayName();
    var since = state.activity && state.activity.since;
    els.statsSince.textContent = since ? "В Snowball.ai с " + MONTHS[new Date(since).getMonth()] + " " + new Date(since).getFullYear() : "";
    var total = state.items.length;
    els.metrics.replaceChildren(
      metric("Действий за год", fmtNum(s.year)),
      metric("Активных дней", fmtNum(s.activeDays)),
      metric("Дней подряд", fmtNum(s.current), "Лучшая серия: " + fmtNum(s.best)),
      metric("Промтов в базе", fmtNum(total))
    );
    var chip = function (label, n) { return h("span", { class: "bchip" }, label + " ", h("b", { text: fmtNum(n) })); };
    els.breakdown.replaceChildren(
      chip("Создано промтов", s.by.created), chip("Правок", s.by.edited),
      chip("Прикреплено файлов", s.by.files), chip("Скопировано", s.by.copied),
      chip("Дел в календаре", s.by.calendar), chip("Сообщений ассистенту", s.by.assistant));
    renderTopUse(s);
    renderHeat();
    fillAvatar(els.statsAvatar, p.avatar, p.name);
  }
  els.heat.addEventListener("mouseover", function (e) {
    var t = e.target && e.target.dataset && e.target.dataset.tip;
    if (t) els.heatTip.textContent = t;
  });
  els.navItems.forEach(function (b) { b.addEventListener("click", function () { setPage(b.dataset.page); }); });

  /* ---------- profile window ---------- */
  // avatar: undefined = keep the saved one, null = remove it, string = a new picture (data URL).
  var pd = { avatar: undefined, welcome: false };
  function pdAvatar() { return pd.avatar === undefined ? (state.profile && state.profile.avatar) || null : pd.avatar; }
  function renderPdAvatar() {
    fillAvatar(els.pdAvatar, pdAvatar(), els.pdName.value);
    els.pdRemove.hidden = !pdAvatar();
  }
  // welcome: the first-start version with "Пропустить" instead of "Отмена".
  function openProfile(welcome) {
    setMenu(false);
    pd.avatar = undefined;
    pd.welcome = !!welcome;
    els.pdTitle.textContent = welcome ? "Добро пожаловать в Snowball.ai" : "Профиль";
    els.pdText.textContent = welcome ? "Как вас называть? Ник и аватарка видны внизу слева, поменять их можно в любой момент." : "";
    els.pdSave.textContent = welcome ? "Начать" : "Сохранить";
    els.pdCancel.textContent = welcome ? "Пропустить" : "Отмена";
    els.pdRestore.hidden = !welcome;
    els.pdName.value = (state.profile && state.profile.name) || "";
    els.pdMsg.textContent = "";
    els.pdSave.disabled = false;
    renderPdAvatar();
    if (!els.profileDlg.open) els.profileDlg.showModal();
    els.pdName.focus();
  }
  function closeProfile() {
    if (!pd.welcome) { els.profileDlg.close(); return; }
    // Skipping the welcome still remembers it was shown, so it does not come back on every start.
    call(api.saveProfile({})).then(function () { els.profileDlg.close(); render(); });
  }
  els.pdName.addEventListener("input", function () { els.pdMsg.textContent = ""; renderPdAvatar(); });
  els.pdPick.addEventListener("click", function () {
    call(api.pickAvatar()).then(function (r) {
      if (!r || r.canceled) return;
      pd.avatar = r.avatar;
      renderPdAvatar();
    });
  });
  els.pdRemove.addEventListener("click", function () { pd.avatar = null; renderPdAvatar(); });
  els.pdCancel.addEventListener("click", closeProfile);
  // A clean install (or a new computer): bring everything back from a .snowball file right away.
  els.pdRestoreBtn.addEventListener("click", function () {
    els.profileDlg.close();
    call(api.archiveOpen()).then(function (r) {
      if (r && !r.canceled) archiveDone(r);
      if (!state.profile || !state.profile.welcomed) openProfile(true);
    });
  });
  els.profileDlg.addEventListener("cancel", function (e) { e.preventDefault(); closeProfile(); });
  els.pdForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = els.pdName.value.trim();
    if (pd.welcome && !name) { els.pdMsg.textContent = "Введите ник или нажмите «Пропустить»."; els.pdName.focus(); return; }
    var input = { name: name };
    if (pd.avatar !== undefined) input.avatar = pd.avatar;
    els.pdSave.disabled = true;
    call(api.saveProfile(input)).then(function (r) {
      els.pdSave.disabled = false;
      if (!r) return;
      var wasWelcome = pd.welcome;
      els.profileDlg.close();
      render();
      toast(wasWelcome ? "Приятно познакомиться, " + name + "!" : "Профиль сохранён");
    });
  });
  els.statsEdit.addEventListener("click", function () { openProfile(false); });
  function renderViewerIfChanged() {
    var item = findItem(viewerState.promptId);
    if (!item || !item.files.length) closeViewer();
  }

  /* ---------- menu ---------- */
  function setMenu(open) {
    els.menu.hidden = !open;
    els.menuBtn.setAttribute("aria-expanded", String(open));
    if (!open) openSub(null);
    if (open) { var f = els.menu.querySelector("button"); if (f) f.focus(); }
  }
  // "Тема ›" and "Промты ›" open a second list to the right: on hover, on click or with the right arrow.
  function openSub(name, focusFirst) {
    els.menu.querySelectorAll(".sub-wrap").forEach(function (w) {
      var btn = w.querySelector(".has-sub"), on = !!name && btn.dataset.sub === name;
      w.classList.toggle("open", on);
      btn.setAttribute("aria-expanded", String(on));
      if (on) fitSubmenu(w.querySelector(".submenu"));
      if (on && focusFirst) { var f = w.querySelector(".submenu button[aria-checked=\"true\"]") || w.querySelector(".submenu button"); if (f) f.focus(); }
    });
  }
  // The profile menu sits at the bottom of the window, so a list opened downwards could go under the Windows
  // taskbar. After opening, a list that does not fit moves up (or down) just enough to be fully visible.
  function fitSubmenu(list) {
    if (!list) return;
    list.style.top = "";
    list.style.bottom = "";
    var r = list.getBoundingClientRect(), gap = 8;
    var over = r.bottom - (window.innerHeight - gap);
    var move = over > 0 ? -over : r.top < gap ? gap - r.top : 0;
    if (!move) return;
    list.style.top = (list.offsetTop + move) + "px";
    list.style.bottom = "auto";   // the effort list is pinned by its bottom edge in styles.css
  }
  // The mouse travels from "Тема" to its list across other items and a small gap, so a list closes or switches
  // only after a short pause: on the way it stays open. A hidden bridge in styles.css covers the gap.
  var subTimer = null;
  function subLater(fn, ms) { clearTimeout(subTimer); subTimer = setTimeout(fn, ms); }
  function openSubName() { var b = els.menu.querySelector(".sub-wrap.open .has-sub"); return b ? b.dataset.sub : null; }
  els.menu.querySelectorAll(".sub-wrap").forEach(function (w) {
    var name = w.querySelector(".has-sub").dataset.sub;
    w.addEventListener("mouseenter", function () {
      var open = openSubName();
      if (!open || open === name) { clearTimeout(subTimer); openSub(name); }
      else subLater(function () { openSub(name); }, 260);
    });
    w.addEventListener("mouseleave", function () { subLater(function () { if (!w.contains(document.activeElement)) openSub(null); }, 350); });
    w.querySelector(".has-sub").addEventListener("click", function () { clearTimeout(subTimer); openSub(name, true); });
  });
  els.menu.querySelectorAll(":scope > button, :scope > hr").forEach(function (b) {
    b.addEventListener("mouseenter", function () { subLater(function () { openSub(null); }, 260); });
  });
  els.menuBtn.addEventListener("click", function () { setMenu(els.menu.hidden); });
  document.addEventListener("mousedown", function (e) {
    if (!els.menu.hidden && !els.menu.contains(e.target) && !els.menuBtn.contains(e.target)) setMenu(false);
  });
  els.menu.addEventListener("keydown", function (e) {
    var sub = document.activeElement && document.activeElement.closest(".submenu");
    var scope = sub || els.menu;
    var items = Array.prototype.slice.call(scope.querySelectorAll(sub ? "button" : ":scope > button, :scope > .sub-wrap > .has-sub"));
    var i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); setMenu(false); els.menuBtn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === "ArrowRight" && document.activeElement.classList.contains("has-sub")) { e.preventDefault(); openSub(document.activeElement.dataset.sub, true); }
    else if (e.key === "ArrowLeft" && sub) { e.preventDefault(); var w = sub.closest(".sub-wrap"); openSub(null); w.querySelector(".has-sub").focus(); }
  });
  var THEME_NAMES = { system: "Как в Windows", light: "Светлая", dark: "Тёмная", white: "Белая", black: "Чёрная" };
  function markTheme(theme) {
    var t = theme || "system";
    els.menu.querySelectorAll("button[data-theme]").forEach(function (b) {
      b.setAttribute("aria-checked", String(b.dataset.theme === t));
    });
    els.themeValue.textContent = THEME_NAMES[t] || "";
    // "Белая" and "Чёрная" are colour sets on top of the light and dark ones (styles.css, :root[data-theme]).
    if (t === "white" || t === "black") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  // Theme items keep the menu open, so the change can be seen right away.
  els.menu.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-theme]");
    if (!b) return;
    call(api.setTheme(b.dataset.theme)).then(function (r) { if (r) markTheme(r.info.theme); });
  });
  els.menu.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-action]");
    if (!b) return;
    setMenu(false);
    var a = b.dataset.action;
    if (a === "edit-profile") openProfile(false);
    else if (a === "settings") openSettings();
    else if (a === "open-dir") call(api.openDataDir());
    else if (a === "change-dir") changeDir();
    else if (a === "export") exportPrompts(null);
    else if (a === "import") openArchive();
  });
  /* ---------- backup and sharing ---------- */
  // ".snowprompt" carries prompts with comments and files to another Snowball.ai; ".snowball" is a backup of everything.
  function exportPrompts(ids) {
    call(api.promptsExport(ids)).then(function (r) {
      if (!r || r.canceled) return;
      var c = r.counts;
      toast("Сохранено: " + c.prompts + " " + plural(c.prompts, "промт", "промта", "промтов") +
        (c.files ? " и " + c.files + " " + plural(c.files, "файл", "файла", "файлов") : "") + ". Этот файл можно отправить другу.", true);
    });
  }
  // In the settings window the result is written under the buttons, otherwise in the banner.
  function backupMessage(text) {
    if (els.settingsDlg.open) els.setBackupMsg.textContent = text; else showBanner(text);
  }
  function exportBackup() {
    toast("Собираю резервную копию…");
    call(api.backupExport()).then(function (r) {
      if (!r || r.canceled) return;
      var c = r.counts;
      backupMessage("Резервная копия сохранена: " + r.path + ". В ней промтов " + c.prompts + ", файлов " + c.files + ", разговоров " + c.chats + ", дел в календаре " + c.events + ". Ключей ChatGPT и Claude в ней нет.");
    });
  }
  // file: a path (drag and drop) or nothing (the program asks which file).
  function openArchive(file) {
    if (editorDirty()) { toast("Сначала сохраните или отмените правку промта."); return; }
    call(api.archiveOpen(file)).then(archiveDone);
  }
  function archiveDone(r) {
    if (!r) return;
    if (!r.ok) { toast(r.error || "Не получилось открыть файл.", true); return; }
    if (r.canceled) return;
    applyData(r);
    var x = r.result || {};
    if (r.kind === "backup") {
      refreshChats();
      render();
      var parts = [];
      if (x.prompts) parts.push("промтов " + x.prompts);
      if (x.chats) parts.push("разговоров " + x.chats);
      if (x.events) parts.push("дел в календаре " + x.events);
      backupMessage(parts.length ? "Восстановлено из копии: " + parts.join(", ") + (x.skipped ? ". Уже были в программе и остались как есть: " + x.skipped : "") + "."
        : "Всё из этой копии уже есть в программе, ничего добавлять не пришлось.");
      return;
    }
    render();
    if (els.settingsDlg.open) els.settingsDlg.close();
    if (x.prompts) {
      setPage("prompts");
      toast("Добавлено: " + x.prompts + " " + plural(x.prompts, "промт", "промта", "промтов") + (x.files ? " и " + x.files + " " + plural(x.files, "файл", "файла", "файлов") : "") +
        (x.skipped ? ". Уже были у вас: " + x.skipped : ""), true);
    } else toast("Новых промтов в файле нет: все уже есть в таблице", true);
  }
  // A double click on a file in Windows while the program is open (or that started it).
  api.onArchiveOpened(archiveDone);

  function changeDir() {
      if (editorDirty()) { toast("Сначала сохраните или отмените правку промта."); return; }
      call(api.changeDataDir()).then(function (r) {
        if (!r || r.canceled) return;
        if (state.editorOpen) closeEditor(false);
        // Conversations live in the data folder too: show the ones from the new folder.
        api.assistantReset();
        sessions.forEach(function (se) { clearChat(se); });
        refreshChats();
        saveTabs();
        closeEventForm();
        state.expanded.clear();
        tileCache.clear();
        render();
        if (r.mode === "copied") showBanner("Промты и файлы скопированы в новую папку. Старая папка осталась на месте: " + r.oldDir + ". Её можно удалить, когда убедитесь, что всё на месте.");
        else toast("Открыл промты из выбранной папки", true);
      });
  }
  els.setDir.addEventListener("click", function () { call(api.openDataDir()); });
  els.setDirChange.addEventListener("click", changeDir);
  els.setBackupSave.addEventListener("click", exportBackup);
  els.setBackupOpen.addEventListener("click", function () { openArchive(); });

  /* ---------- settings window ---------- */
  // Sections on the left, the chosen one on the right; the program stays where it was behind it.
  var settingsSec = "keys";
  function showSettingsSection(sec) {
    settingsSec = sec;
    els.settingsDlg.querySelectorAll(".sd-sec").forEach(function (el) { el.hidden = el.dataset.sec !== sec; });
    els.settingsDlg.querySelectorAll(".sd-item").forEach(function (b) {
      if (b.dataset.sec === sec) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    els.settingsMain.scrollTop = 0;
  }
  function openSettings(sec) {
    setMenu(false);
    showSettingsSection(sec || settingsSec);
    els.setBackupMsg.textContent = "";
    if (!els.settingsDlg.open) { els.settingsDlg.showModal(); els.settingsDlg.focus(); }
  }
  els.settingsDlg.querySelectorAll(".sd-item").forEach(function (b) {
    b.addEventListener("click", function () { showSettingsSection(b.dataset.sec); });
  });
  els.settingsClose.addEventListener("click", function () { els.settingsDlg.close(); });
  // A click on the dark area around the window closes it.
  els.settingsDlg.addEventListener("mousedown", function (e) { if (e.target === els.settingsDlg) els.settingsDlg.close(); });
  els.settingsDlg.addEventListener("close", function () { if (els.toast.parentNode !== document.body) document.body.appendChild(els.toast); });

  /* ---------- updates ---------- */
  // Settings → "Обновление": check, read what is new, download, restart. A new version is downloaded
  // only after the user presses "Скачать обновление"; the background check only shows a banner.
  // status: idle, checking, latest, error, available, progress, download-error, ready.
  var upd = { packaged: false, current: "", currentNotes: "", status: "idle", version: "", notes: "", percent: 0, size: 0, transferred: 0, total: 0, dismissed: null, progressHidden: false };
  function fmtMB(bytes) {
    var mb = bytes / (1024 * 1024);
    return (mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace(".", ",")) + " МБ";
  }
  function sizeNote() { return upd.size ? " Размер обновления — " + fmtMB(upd.size) + "." : ""; }
  function updButton(label, primary, onclick, disabled) {
    return h("button", { type: "button", class: "btn " + (primary ? "btn-primary" : "btn-ghost"), disabled: !!disabled, onclick: onclick }, label);
  }
  function renderUpdates() {
    var s = upd.status, v = upd.version, found = s === "available" || s === "progress" || s === "download-error" || s === "ready";
    var line, actions = [];
    if (!upd.packaged && !found) {
      line = "У вас версия " + upd.current + ". Обновления проверяются только в установленной программе.";
      actions.push(updButton("Проверить обновления", true, null, true));
    } else if (s === "checking") {
      line = "Проверяю, нет ли новой версии…";
      actions.push(updButton("Проверяю…", true, null, true));
    } else if (s === "latest") {
      line = "У вас последняя версия — " + upd.current + ".";
      actions.push(updButton("Проверить ещё раз", false, checkForUpdates));
    } else if (s === "error") {
      line = "Не получилось проверить обновления. Проверьте интернет и попробуйте ещё раз.";
      actions.push(updButton("Попробовать ещё раз", true, checkForUpdates));
    } else if (s === "available") {
      line = "Вышла новая версия " + v + ". Сейчас у вас " + upd.current + "." + sizeNote() + " Скачивание займёт около минуты, а установится она после перезапуска.";
      actions.push(updButton("Скачать обновление", true, startDownload));
    } else if (s === "progress") {
      var total = upd.total || upd.size;
      line = "Скачиваю версию " + v + ": " + (total ? fmtMB(upd.transferred) + " из " + fmtMB(total) + ", " : "") + upd.percent + "%. Можно закрыть настройки и продолжать работать, программа сообщит, когда всё будет готово.";
    } else if (s === "download-error") {
      line = "Не получилось скачать версию " + v + ". Проверьте интернет и попробуйте ещё раз.";
      actions.push(updButton("Попробовать ещё раз", true, startDownload));
    } else if (s === "ready") {
      line = "Версия " + v + " скачана" + (upd.size ? " (" + fmtMB(upd.size) + ")" : "") + ". Перезапустите программу, чтобы её установить. Если не сейчас, она установится сама, когда вы закроете программу.";
      actions.push(updButton("Перезапустить и обновить", true, installNow));
    } else {
      line = "У вас версия " + upd.current + ".";
      actions.push(updButton("Проверить обновления", true, checkForUpdates));
    }
    els.updLine.textContent = line;
    els.updActions.replaceChildren.apply(els.updActions, actions);
    els.updActions.hidden = !actions.length;
    els.updBar.hidden = s !== "progress";
    els.updBarFill.style.width = upd.percent + "%";
    els.updBadge.textContent = found ? "Есть новая версия" + (upd.size ? " · " + fmtMB(upd.size) : "") : upd.current ? "Версия " + upd.current : "";
    els.updBadge.className = "set-status" + (found ? " new" : "");
    els.setNavDot.hidden = !found;
    els.updNew.hidden = !found;
    if (found) {
      els.updNewTitle.textContent = "Что нового в версии " + v;
      els.updNewBody.replaceChildren.apply(els.updNewBody, upd.notes ? richText(upd.notes)
        : [h("p", { text: "Описание этой версии не загрузилось. Его можно прочитать на GitHub по ссылке ниже." })]);
    }
    els.updCurrent.hidden = !upd.currentNotes;
    els.updCurrentTitle.textContent = "Что нового в вашей версии " + upd.current;
    els.updCurrentBody.replaceChildren.apply(els.updCurrentBody, upd.currentNotes ? richText(upd.currentNotes) : []);
  }
  function checkForUpdates() {
    upd.status = "checking";
    renderUpdates();
    call(api.checkUpdates()).then(function (r) { if (!r && upd.status === "checking") { upd.status = "error"; renderUpdates(); } });
  }
  function startDownload() {
    call(api.downloadUpdate()).then(function (r) {
      if (!r) return;
      upd.status = "progress";
      upd.percent = 0;
      upd.transferred = 0;
      upd.progressHidden = false;
      renderUpdates();
    });
  }
  // While the settings window is closed, the download shows in a banner with its own bar.
  function showProgressBanner() {
    if (upd.progressHidden || updatesInView()) return;
    var total = upd.total || upd.size;
    showBanner("Скачиваю Snowball.ai " + upd.version + ": " + (total ? fmtMB(upd.transferred) + " из " + fmtMB(total) + ", " : "") + upd.percent + "%.", {
      label: "Подробнее", close: "Скрыть", percent: upd.percent,
      onclick: function () { els.banner.hidden = true; openUpdates(false); },
      onclose: function () { upd.progressHidden = true; }
    });
  }
  function updatesInView() { return els.settingsDlg.open && settingsSec === "update"; }
  function installNow() {
    if (editorDirty()) { toast("Сначала сохраните или отмените правку промта."); return; }
    call(api.installUpdate());
  }
  // Opens Settings at the "Обновление" card; showCurrent unfolds what is new in the installed version.
  function openUpdates(showCurrent) {
    if (showCurrent) els.updCurrent.open = true;
    openSettings("update");
  }
  api.onUpdate(function (u) {
    var away = !updatesInView();
    if (u.notes !== undefined) upd.notes = u.notes || "";
    if (u.version) upd.version = u.version;
    if (u.size) upd.size = u.size;
    if (u.transferred !== undefined) upd.transferred = u.transferred;
    if (u.total) upd.total = u.total;
    if (u.kind === "available") {
      upd.status = "available";
      // The background check asks once per version; the button in Settings shows it right there.
      if (away && !u.manual && upd.dismissed !== u.version) {
        showBanner("Вышла новая версия Snowball.ai " + u.version + (upd.size ? " (" + fmtMB(upd.size) + ")" : "") + ". Посмотрите, что в ней нового, и скачайте её в «Настройках».", {
          label: "Что нового", close: "Не сейчас",
          onclick: function () { els.banner.hidden = true; openUpdates(false); },
          onclose: function () { upd.dismissed = u.version; }
        });
      }
    }
    else if (u.kind === "progress") { upd.status = "progress"; upd.percent = u.percent || 0; showProgressBanner(); }
    else if (u.kind === "download-error") {
      upd.status = "download-error";
      if (away) showBanner("Не получилось скачать Snowball.ai " + u.version + ". Проверьте интернет и попробуйте ещё раз.", {
        label: "Попробовать ещё раз", close: "Не сейчас", onclick: function () { els.banner.hidden = true; startDownload(); }
      });
    }
    else if (u.kind === "latest") { if (u.manual || upd.status === "checking") upd.status = "latest"; }
    else if (u.kind === "error") { if (u.manual || upd.status === "checking") upd.status = "error"; }
    else if (u.kind === "ready") {
      upd.status = "ready";
      showBanner("Скачана новая версия Snowball.ai " + u.version + ". Перезапустите программу, чтобы её установить. Если не сейчас, она установится сама, когда вы закроете программу.", {
        label: "Перезапустить и обновить", close: "Позже", onclick: installNow
      });
    }
    renderUpdates();
  });
  api.updateState().then(function (r) {
    if (!r || !r.ok) return;
    upd.packaged = r.packaged;
    upd.current = r.current;
    upd.currentNotes = r.currentNotes || "";
    if (r.status) {
      upd.status = r.status; upd.version = r.version; upd.notes = r.notes || ""; upd.percent = r.percent || 0;
      upd.size = r.size || 0; upd.transferred = r.transferred || 0; upd.total = r.total || 0;
    }
    renderUpdates();
    // Just updated: tell once what changed.
    if (r.whatsNew && upd.currentNotes) {
      showBanner("Snowball.ai обновлена до версии " + r.whatsNew + ". Посмотрите, что нового и как этим пользоваться.", {
        label: "Что нового", close: "Понятно",
        onclick: function () { els.banner.hidden = true; openUpdates(true); }
      });
    }
  }, function () {});

  /* ---------- calendar ---------- */
  var KINDS = [
    { id: "task", label: "Задача" }, { id: "meet", label: "Встреча" }, { id: "call", label: "Звонок" },
    { id: "shoot", label: "Съёмка" }, { id: "edit", label: "Монтаж" }
  ];
  var REMIND_LABELS = { 15: "за 15 минут", 30: "за 30 минут", 60: "за час", 1440: "за день" };
  var WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  var MONTHS_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  var CAL_VIEWS = { month: { name: "Месяц", days: 0 }, week: { name: "Неделя", days: 7 }, "3days": { name: "3 дня", days: 3 }, day: { name: "День", days: 1 } };
  var HOUR_H = 48;   // height of one hour in the week, 3-day and day views, px
  // Official days off in Russia. The holidays are the same every year; moved days off come from the government
  // decree for each year (2027: decree of 17.09.2026 No. 1187) and have to be added here when a new one comes out.
  var HOLIDAYS = {
    "01-01": "Новогодние каникулы", "01-02": "Новогодние каникулы", "01-03": "Новогодние каникулы", "01-04": "Новогодние каникулы",
    "01-05": "Новогодние каникулы", "01-06": "Новогодние каникулы", "01-07": "Рождество", "01-08": "Новогодние каникулы",
    "02-23": "День защитника Отечества", "03-08": "Международный женский день", "05-01": "Праздник Весны и Труда",
    "05-09": "День Победы", "06-12": "День России", "11-04": "День народного единства"
  };
  var MOVED_OFF = {
    2026: ["01-09", "03-09", "05-11", "12-31"],
    2027: ["02-22", "05-03", "05-10", "06-14", "11-05", "12-31"]
  };
  var cal = { mode: "month", view: null, selected: null, editing: null, confirmDelete: false };
  try { if (CAL_VIEWS[localStorage.getItem("calView")]) cal.mode = localStorage.getItem("calView"); } catch (e) {}

  function keyToDate(k) { var p = k.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function holidayName(d) {
    var md = pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    if (HOLIDAYS[md]) return HOLIDAYS[md];
    return (MOVED_OFF[d.getFullYear()] || []).indexOf(md) !== -1 ? "Перенесённый выходной" : null;
  }
  function isDayOff(d) { return d.getDay() === 0 || d.getDay() === 6 || !!holidayName(d); }
  function eventsOn(k) { return state.events.filter(function (e) { return e.date === k; }); }
  function busyLevel(n) { return n <= 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3; }
  function byKind(id) { return KINDS.find(function (k) { return k.id === id; }) || null; }
  function kindOfEvent(e) { return byKind(e.kind) || KINDS[0]; }
  function weekdayName(d) { return WEEKDAYS[(d.getDay() + 6) % 7]; }
  // "Вторник, 3 ноября" (with the year when it is not this year).
  function longDay(k) {
    var d = keyToDate(k), name = weekdayName(d);
    return name.charAt(0).toUpperCase() + name.slice(1) + ", " + fmtDay(d, d.getFullYear() !== new Date().getFullYear());
  }
  function timeRange(e) { return e.from + (e.to ? "–" + e.to : ""); }
  function minutesOf(t) { return +t.slice(0, 2) * 60 + +t.slice(3); }

  function ensureCal() {
    if (cal.view) return;
    var t = today();
    cal.view = new Date(t.getFullYear(), t.getMonth(), 1);
    cal.selected = dayKey(t);
  }
  // The days the week / 3-day / day views show.
  function shownDays() {
    var sel = keyToDate(cal.selected);
    var start = cal.mode === "week" ? addDays(sel, -((sel.getDay() + 6) % 7)) : sel;
    var out = [];
    for (var i = 0; i < CAL_VIEWS[cal.mode].days; i++) out.push(addDays(start, i));
    return out;
  }
  function rangeTitle(days) {
    var a = days[0], b = days[days.length - 1], y = b.getFullYear();
    if (days.length === 1) return longDay(dayKey(a)) + (a.getFullYear() !== new Date().getFullYear() ? "" : " " + y);
    if (a.getMonth() === b.getMonth()) return a.getDate() + "–" + b.getDate() + " " + MONTHS[b.getMonth()] + " " + y;
    return fmtDay(a, a.getFullYear() !== y) + " – " + fmtDay(b) + " " + y;
  }

  function renderMonth() {
    var y = cal.view.getFullYear(), m = cal.view.getMonth();
    els.calTitle.textContent = MONTHS_NOM[m] + " " + y;
    var kids = WEEKDAYS_SHORT.map(function (w, i) { return h("div", { class: "cal-wd" + (i >= 5 ? " off" : ""), text: w }); });
    var first = new Date(y, m, 1);
    var start = addDays(first, -((first.getDay() + 6) % 7));
    var todayKey = dayKey(today());
    var count = 0;
    for (var i = 0; i < 42; i++) {
      var d = addDays(start, i);
      if (i === 35 && d.getMonth() !== m) break;
      var k = dayKey(d), list = eventsOn(k), hol = holidayName(d);
      if (d.getMonth() === m) count += list.length;
      var cls = "cal-cell";
      if (d.getMonth() !== m) cls += " other";
      if (isDayOff(d)) cls += " off";
      if (busyLevel(list.length)) cls += " b" + busyLevel(list.length);
      if (k === todayKey) cls += " today";
      if (k === cal.selected) cls += " sel";
      var shown = hol ? 1 : 2;
      var tip = (hol ? hol + ". " : "") + (list.length ? list.length + " " + plural(list.length, "дело", "дела", "дел") : "Свободно");
      kids.push(h("button", { type: "button", class: cls, title: tip, "aria-label": fmtDay(d) + ". " + tip, "aria-pressed": String(k === cal.selected),
        onclick: (function (k) { return function () { selectDay(k); }; })(k),
        ondblclick: (function (k) { return function () { cal.selected = k; setCalMode("day"); }; })(k) },
        h("span", { class: "num", text: String(d.getDate()) }),
        hol ? h("span", { class: "hol", text: hol }) : null,
        list.slice(0, shown).map(function (e) { return h("span", { class: "ev ev-" + kindOfEvent(e).id }, h("i"), e.from + " " + e.title); }),
        list.length > shown ? h("span", { class: "more", text: "ещё " + (list.length - shown) }) : null));
    }
    els.calGrid.replaceChildren.apply(els.calGrid, kids);
    els.calMeta.textContent = count ? "В этом месяце " + count + " " + plural(count, "дело", "дела", "дел") : "В этом месяце дел нет";
  }
  // The event that is going on right now (one without an end counts as half an hour).
  function isNowEvent(e) {
    var now = new Date();
    if (e.date !== dayKey(now) || !e.from) return false;
    var m = now.getHours() * 60 + now.getMinutes(), s0 = minutesOf(e.from), s1 = e.to ? minutesOf(e.to) : s0 + 30;
    return m >= s0 && m < s1;
  }
  function eventBlock(e) {
    var k = kindOfEvent(e), now = isNowEvent(e);
    return h("button", { type: "button", class: "cal-ev ev-" + k.id + (now ? " now" : ""), title: now ? "Идёт сейчас. Изменить дело" : "Изменить дело", onclick: function (x) { x.stopPropagation(); openEventForm(e); } },
      h("span", { class: "row1" }, h("span", { class: "tm", text: timeRange(e) }), h("span", { class: "ttl", text: e.title }), h("span", { class: "kind", text: k.label })),
      e.note ? h("span", { class: "note", text: e.note }) : null,
      e.remind ? h("span", { class: "bell", text: "Напомнить " + (REMIND_LABELS[e.remind] || "") }) : null);
  }
  function renderDay() {
    var k = cal.selected, d = keyToDate(k), list = eventsOn(k), hol = holidayName(d);
    els.calDayTitle.textContent = longDay(k);
    els.calDaySub.textContent = list.length ? list.length + " " + plural(list.length, "дело", "дела", "дел") : "Свободный день";
    if (hol || isDayOff(d)) els.calDayBadge.replaceChildren(h("span", { class: "cal-badge", text: hol || "Выходной" }));
    else els.calDayBadge.replaceChildren();
    var firstHour = Math.min(7, list.length ? +list[0].from.slice(0, 2) : 7);
    var rows = [];
    for (var hr = firstHour; hr <= 23; hr++) {
      var inHour = list.filter(function (e) { return +e.from.slice(0, 2) === hr; });
      rows.push(h("div", { class: "cal-hour" }, h("span", { class: "t", text: pad2(hr) + ":00" }),
        h("div", { class: "slot" + (inHour.length ? "" : " empty"), title: inHour.length ? null : "Добавить дело на " + pad2(hr) + ":00",
          onclick: (function (hr) { return function () { openEventForm(null, pad2(hr) + ":00"); }; })(hr) },
          inHour.map(eventBlock))));
    }
    els.calTimeline.replaceChildren.apply(els.calTimeline, rows);
    var now = new Date(), row = rows[now.getHours() - firstHour];
    if (k === dayKey(now) && row) {
      var line = h("div", { class: "cal-now", "aria-hidden": "true" });
      els.calTimeline.prepend(line);
      line.style.top = (row.offsetTop + row.offsetHeight * now.getMinutes() / 60) + "px";
    }
  }

  // Week, 3 days and one day: a column per day, events placed by their time like in Google Calendar.
  function renderWeek() {
    var days = shownDays(), todayKey = dayKey(today());
    els.calTitle.textContent = rangeTitle(days);
    var all = [];
    days.forEach(function (d) { all = all.concat(eventsOn(dayKey(d))); });
    els.calMeta.textContent = all.length ? all.length + " " + plural(all.length, "дело", "дела", "дел") + " за эти дни" : "В эти дни дел нет";
    var startHour = Math.min(7, all.length ? Math.min.apply(null, all.map(function (e) { return +e.from.slice(0, 2); })) : 7);
    var cols = "52px repeat(" + days.length + ", minmax(0, 1fr))";
    els.cwHead.style.gridTemplateColumns = cols;
    els.cwBody.style.gridTemplateColumns = cols;
    els.cwHead.replaceChildren.apply(els.cwHead, [h("div")].concat(days.map(function (d) {
      var k = dayKey(d), hol = holidayName(d);
      return h("button", { type: "button", class: "cw-day" + (isDayOff(d) ? " off" : "") + (k === todayKey ? " today" : ""), title: "Открыть день",
        onclick: function () { cal.selected = k; setCalMode("day"); } },
        h("span", { class: "wd", text: WEEKDAYS_SHORT[(d.getDay() + 6) % 7] }), h("span", { class: "num", text: String(d.getDate()) }),
        hol ? h("span", { class: "hol", text: hol }) : null);
    })));
    var hours = [];
    for (var hr = startHour; hr <= 23; hr++) hours.push(h("div", { class: "cw-t", text: pad2(hr) + ":00" }));
    var height = (24 - startHour) * HOUR_H;
    var columns = days.map(function (d) {
      var k = dayKey(d), list = eventsOn(k);
      var col = h("div", { class: "cw-col" + (isDayOff(d) ? " off" : "") });
      col.style.height = height + "px";
      col.style.backgroundSize = "100% " + HOUR_H + "px";
      col.addEventListener("click", function (e) {
        if (e.target !== col) return;
        var hrClicked = startHour + Math.floor(e.offsetY / HOUR_H);
        cal.selected = k;
        openEventForm(null, pad2(Math.min(23, hrClicked)) + ":00");
      });
      // Overlapping events share the width: each goes to the first free lane.
      var lanes = [], placed = [];
      list.forEach(function (e) {
        var s0 = minutesOf(e.from), s1 = e.to ? minutesOf(e.to) : s0 + 30;
        var lane = lanes.findIndex(function (end) { return end <= s0; });
        if (lane === -1) { lane = lanes.length; lanes.push(s1); } else lanes[lane] = s1;
        placed.push({ e: e, s0: s0, s1: s1, lane: lane });
      });
      placed.forEach(function (pl) {
        var b = eventBlock(pl.e);
        b.classList.add("cw-ev");
        if (pl.s1 - pl.s0 <= 45) b.classList.add("short");
        b.style.top = ((pl.s0 - startHour * 60) / 60 * HOUR_H) + "px";
        var hgt = Math.max(24, (pl.s1 - pl.s0) / 60 * HOUR_H - 2);
        b.style.height = hgt + "px";
        // As many whole lines as fit (a one-hour event shows two), the rest ends with "…"; the full text is in the tooltip.
        b.querySelector(".row1").style.webkitLineClamp = String(Math.max(1, Math.floor((hgt - 8) / 16)));
        b.title = timeRange(pl.e) + " " + pl.e.title + (pl.e.note ? " — " + pl.e.note : "");
        b.style.left = "calc(" + (pl.lane / lanes.length * 100) + "% + 2px)";
        b.style.width = "calc(" + (100 / lanes.length) + "% - 4px)";
        col.append(b);
      });
      if (k === todayKey) {
        var now = new Date(), line = h("div", { class: "cal-now", "aria-hidden": "true" });
        line.style.left = "0";
        line.style.top = ((now.getHours() * 60 + now.getMinutes() - startHour * 60) / 60 * HOUR_H) + "px";
        if (now.getHours() >= startHour) col.append(line);
      }
      return col;
    });
    els.cwBody.replaceChildren.apply(els.cwBody, [h("div", { class: "cw-hours" }, hours)].concat(columns));
    els.cwBody.classList.toggle("one-day", days.length === 1);
    // The day header lines up with the columns even when the hours have a scrollbar.
    els.cwHead.style.paddingRight = (els.cwBody.offsetWidth - els.cwBody.clientWidth) + "px";
    cal.startHour = startHour;
  }

  function renderCalendar() {
    ensureCal();
    var month = cal.mode === "month";
    els.calMonthView.hidden = !month;
    els.calWeekView.hidden = month;
    els.calViewName.textContent = CAL_VIEWS[cal.mode].name;
    els.calViewMenu.querySelectorAll("[data-view]").forEach(function (b) { b.setAttribute("aria-checked", String(b.dataset.view === cal.mode)); });
    if (month) { renderMonth(); renderDay(); }
    else renderWeek();
  }
  function setCalMode(mode) {
    cal.mode = mode;
    try { localStorage.setItem("calView", mode); } catch (e) {}
    var d = keyToDate(cal.selected);
    cal.view = new Date(d.getFullYear(), d.getMonth(), 1);
    renderCalendar();
    // Start the hour grid around the working day rather than at night.
    if (mode !== "month") scrollToWorkday();
  }
  // Opens the hour grid at 8 in the morning (or at the first event of the shown days if it is later).
  function scrollToWorkday() {
    var days = shownDays(), first = 24;
    days.forEach(function (d) { eventsOn(dayKey(d)).forEach(function (e) { var hr = +e.from.slice(0, 2); if (hr >= 7 && hr < first) first = hr; }); });
    els.cwBody.scrollTop = Math.max(0, (Math.min(8, first) - (cal.startHour || 0)) * HOUR_H);
  }
  function selectDay(k) {
    cal.selected = k;
    var d = keyToDate(k);
    cal.view = new Date(d.getFullYear(), d.getMonth(), 1);
    renderCalendar();
  }
  function openCalendarDay(k) {
    ensureCal();
    setPage("calendar");
    selectDay(k);
  }
  function stepCalendar(dir) {
    ensureCal();
    if (cal.mode === "month") { cal.view = new Date(cal.view.getFullYear(), cal.view.getMonth() + dir, 1); renderMonth(); return; }
    cal.selected = dayKey(addDays(keyToDate(cal.selected), dir * CAL_VIEWS[cal.mode].days));
    renderCalendar();
    scrollToWorkday();
  }

  /* the view switcher */
  function setCalViewMenu(open) {
    els.calViewMenu.hidden = !open;
    els.calViewBtn.setAttribute("aria-expanded", String(open));
    if (open) { var c = els.calViewMenu.querySelector('[aria-checked="true"]'); if (c) c.focus(); }
  }
  els.calViewBtn.addEventListener("click", function () { setCalViewMenu(els.calViewMenu.hidden); });
  els.calViewMenu.addEventListener("click", function (e) {
    var b = e.target.closest("[data-view]");
    if (!b) return;
    setCalViewMenu(false);
    ensureCal();
    setCalMode(b.dataset.view);
  });
  els.calViewMenu.addEventListener("keydown", function (e) {
    var items = Array.prototype.slice.call(els.calViewMenu.querySelectorAll("button")), i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); setCalViewMenu(false); els.calViewBtn.focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus(); }
  });
  document.addEventListener("mousedown", function (e) {
    if (!els.calViewMenu.hidden && !els.calViewMenu.contains(e.target) && !els.calViewBtn.contains(e.target)) setCalViewMenu(false);
  });

  /* time with a 10-minute step: two lists instead of the Windows clock control */
  function buildTimePick(box, allowEmpty) {
    var hs = h("select", { class: "input tp-h", "aria-label": "Часы" }), ms = h("select", { class: "input tp-m", "aria-label": "Минуты" });
    if (allowEmpty) hs.append(h("option", { value: "", text: "—" }));
    for (var i = 0; i < 24; i++) hs.append(h("option", { value: pad2(i), text: pad2(i) }));
    for (var m = 0; m < 60; m += 10) ms.append(h("option", { value: pad2(m), text: pad2(m) }));
    hs.addEventListener("change", function () { ms.disabled = !hs.value; });
    box.replaceChildren(hs, h("span", { class: "tp-sep", text: ":" }), ms);
  }
  function setTime(box, t) {
    var hs = box.querySelector(".tp-h"), ms = box.querySelector(".tp-m");
    if (!t) { hs.value = ""; ms.value = "00"; ms.disabled = true; return; }
    var mm = t.slice(3);
    // A time an assistant set off the 10-minute grid (14:15) stays as it is.
    if (!ms.querySelector('option[value="' + mm + '"]')) {
      var opt = h("option", { value: mm, text: mm, "data-extra": "1" });
      var after = Array.prototype.find.call(ms.options, function (o) { return o.value > mm; });
      ms.insertBefore(opt, after || null);
    }
    hs.value = t.slice(0, 2);
    ms.value = mm;
    ms.disabled = false;
  }
  function getTime(box) {
    var hs = box.querySelector(".tp-h"), ms = box.querySelector(".tp-m");
    return hs.value ? hs.value + ":" + ms.value : "";
  }
  buildTimePick(els.cfFrom, false);
  buildTimePick(els.cfTo, true);
  els.cfKind.replaceChildren.apply(els.cfKind, KINDS.map(function (k) {
    return h("label", { class: "ev-" + k.id }, h("input", { type: "radio", name: "cf-kind", value: k.id }), h("span", { text: k.label }));
  }));

  // e: an event to change, or null for a new one (time: the hour that was clicked).
  function openEventForm(e, time) {
    ensureCal();
    cal.editing = e ? e.id : "";
    cal.confirmDelete = false;
    els.calFormTitle.textContent = e ? "Изменить дело" : "Новое дело";
    els.cfTitle.value = e ? e.title : "";
    els.cfDate.value = e ? e.date : cal.selected;
    setTime(els.cfFrom, e ? e.from : (time || "10:00"));
    setTime(els.cfTo, e ? e.to : (time ? pad2(Math.min(23, +time.slice(0, 2) + 1)) + ":00" : ""));
    els.cfRemind.value = String(e ? e.remind : 60);
    els.cfNote.value = e ? e.note : "";
    els.cfKind.querySelectorAll("input").forEach(function (i) { i.checked = i.value === (e ? e.kind : "task"); });
    els.cfDelete.hidden = !e;
    els.cfDelete.textContent = "Удалить дело";
    els.cfMsg.textContent = "";
    els.cfSave.disabled = false;
    if (!els.calDialog.open) els.calDialog.showModal();
    els.cfTitle.focus();
  }
  function closeEventForm() {
    if (els.calDialog.open) els.calDialog.close();
    cal.editing = null;
    cal.confirmDelete = false;
  }
  els.calForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (els.cfSave.disabled) return;
    var title = els.cfTitle.value.trim(), from = getTime(els.cfFrom), to = getTime(els.cfTo);
    if (!title) { els.cfMsg.textContent = "Напишите, что за дело."; els.cfTitle.focus(); return; }
    if (!els.cfDate.value) { els.cfMsg.textContent = "Выберите день."; els.cfDate.focus(); return; }
    if (to && to <= from) { els.cfMsg.textContent = "Окончание должно быть позже начала."; els.cfTo.querySelector("select").focus(); return; }
    var checked = els.cfKind.querySelector("input:checked");
    var isNew = !cal.editing;
    var ev = { id: cal.editing || undefined, date: els.cfDate.value, from: from, to: to, title: title,
      kind: checked ? checked.value : "task", remind: +els.cfRemind.value, note: els.cfNote.value.trim() };
    els.cfSave.disabled = true;
    call(api.calSave(ev)).then(function (r) {
      els.cfSave.disabled = false;
      if (!r) return;
      closeEventForm();
      selectDay(r.date);
      toast(isNew ? "Дело добавлено" : "Изменения сохранены");
    });
  });
  els.cfDelete.addEventListener("click", function () {
    if (!cal.editing) return;
    if (!cal.confirmDelete) { cal.confirmDelete = true; els.cfDelete.textContent = "Точно удалить? Нажмите ещё раз"; return; }
    call(api.calDelete(cal.editing)).then(function (r) {
      if (!r) return;
      closeEventForm();
      renderCalendar();
      toast("Дело удалено");
    });
  });
  els.cfCancel.addEventListener("click", closeEventForm);
  els.calDialog.addEventListener("click", function (e) { if (e.target === els.calDialog) closeEventForm(); });
  els.calDialog.addEventListener("close", function () { cal.editing = null; cal.confirmDelete = false; });
  els.calAdd.addEventListener("click", function () { openEventForm(null); });
  els.calDayAdd.addEventListener("click", function () { openEventForm(null); });
  els.calPrev.addEventListener("click", function () { stepCalendar(-1); });
  els.calNext.addEventListener("click", function () { stepCalendar(1); });
  els.calToday.addEventListener("click", function () { ensureCal(); selectDay(dayKey(today())); });
  // A click on a reminder notification opens that day.
  api.onCalendarOpen(function (date) { openCalendarDay(date); });
  // The red "now" line moves on its own.
  setInterval(function () { if (state.page === "calendar" && !els.calDialog.open) renderCalendar(); }, 60 * 1000);

  /* ---------- assistant: conversations ---------- */
  // Every LLM tab has its own conversation (a session), and the small assistant window one more.
  // A session: { quick, id, title, messages, streamId, current, waiting, early, box, draft, loadId }.
  // "chat" is the session of the LLM tab on screen; answers in the other sessions keep coming in the background.
  // main.js gets the whole conversation on every message and streams the answer back through api.onAssistant.
  // After every finished message a conversation is saved to chats.json (the "История" list); the small window is not saved.
  var IDEAS = ["Добавь промт «Неоновый город»", "Улучши промт: кот в космосе", "Поставь созвон на завтра в 15:00", "Сколько у меня промтов?"];
  var QUICK_IDEAS = ["Открой календарь и задачи", "Что у меня на завтра?", "Добавь задачу смонтировать рилс"];
  var LIST_RE = /^\s*([-*•]|\d+[.)])\s+/;
  var hist = { list: [], confirmId: null };   // saved conversations: { id, title, createdAt, updatedAt }; the one asking "Удалить разговор?"
  var sessions = [];
  function newSession(isQuick) {
    var se = {
      quick: !!isQuick,
      id: null,           // null until the first message: an empty "Новый разговор" is not saved
      title: "",
      messages: [],       // { role: "user" | "assistant", text, el, body?, extra?, foot?, actions?, streaming?, note?, failed? }
      streamId: null,     // the answer being written now
      current: null,      // its message
      waiting: false,     // sent, but main.js has not said the stream id yet
      early: [],          // events that came before the id
      box: h("div", { class: "chat-log" }),
      draft: "",          // what was typed in the box before switching to another tab
      loadId: null        // a saved conversation to load when the tab is first opened
    };
    sessions.push(se);
    return se;
  }
  function dropSession(se) { var i = sessions.indexOf(se); if (i !== -1) sessions.splice(i, 1); }
  function sessionOf(msg) { return sessions.find(function (se) { return se.messages.indexOf(msg) !== -1; }) || null; }
  var chat = newSession(false);   // until an LLM tab opens
  var quick = newSession(true);
  function onScreen(se) { return se.quick ? !els.qa.hidden : se === chat && state.page === "assistant"; }

  // A small part of Markdown, enough for answers: paragraphs, lists, **bold**, `code`, ``` blocks and # headings.
  function inline(text) {
    var out = [], re = /\*\*([^*]+)\*\*|`([^`\n]+)`/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(m[1] !== undefined ? h("strong", { text: m[1] }) : h("code", { text: m[2] }));
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function codeBlock(code) {
    var btn = h("button", { type: "button", class: "btn-mini copy rt-copy", onclick: function () {
      api.copyText(code).then(function (r) { if (r && r.ok) markCopied(btn); }, function () {});
    } }, icon("copy"), h("span", { class: "lbl", text: "Копировать" }));
    return h("div", { class: "rt-code" }, h("pre", { text: code }), btn);
  }
  function richText(text) {
    var nodes = [], lines = text.split("\n"), i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*```/.test(line)) {
        var code = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
        i++;
        nodes.push(codeBlock(code.join("\n")));
      } else if (LIST_RE.test(line)) {
        var list = h(/^\s*\d/.test(line) ? "ol" : "ul");
        for (; i < lines.length && LIST_RE.test(lines[i]); i++) list.append(h("li", null, inline(lines[i].replace(LIST_RE, ""))));
        nodes.push(list);
      } else if (/^#{1,4}\s/.test(line)) {
        nodes.push(h("p", { class: "rt-h" }, inline(line.replace(/^#+\s+/, ""))));
        i++;
      } else if (!line.trim()) {
        i++;
      } else {
        var p = h("p");
        for (var first = true; i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !LIST_RE.test(lines[i]); i++, first = false) {
          if (!first) p.append(h("br"));
          p.append.apply(p, inline(lines[i]));
        }
        nodes.push(p);
      }
    }
    return nodes;
  }

  function scrollerOf(se) { return se.quick ? els.qaList : els.scroller; }
  function nearBottom(se) { var el = scrollerOf(se); return el.scrollHeight - el.scrollTop - el.clientHeight < 90; }
  function scrollChat(se) {
    se = se || chat;
    if (!onScreen(se)) return;
    var el = scrollerOf(se);
    el.scrollTop = el.scrollHeight;
  }
  // Keeps the newest text in view, unless the user scrolled up to read something.
  function follow(se, fn) {
    if (!onScreen(se)) { fn(); return; }
    var stick = nearBottom(se);
    fn();
    if (stick) scrollChat(se);
  }

  function renderBody(msg) {
    var kids = richText(msg.text);
    if (msg.streaming && !msg.text) kids = [h("span", { class: "typing", "aria-label": "Ассистент печатает" }, h("i"), h("i"), h("i"))];
    msg.body.replaceChildren.apply(msg.body, kids);
    if (msg.streaming && msg.text) {
      var last = msg.body.lastElementChild;
      if (last && (last.tagName === "UL" || last.tagName === "OL")) last = last.lastElementChild;
      if (last && last.classList.contains("rt-code")) last = null;
      (last || msg.body).append(h("span", { class: "caret", "aria-hidden": "true" }));
    }
  }
  function renderFoot(msg) {
    var kids = [];
    if (msg.note) kids.push(h("span", { class: msg.failed ? "msg-note bad" : "msg-note", text: msg.note }));
    if (msg.failed) kids.push(h("button", { type: "button", class: "link-btn", onclick: function () { retry(msg); } }, "Повторить"));
    if (!msg.streaming && msg.text) {
      var btn = h("button", { type: "button", class: "btn-mini msg-copy", onclick: function () {
        api.copyText(msg.text).then(function (r) { if (r && r.ok) markCopied(btn); }, function () {});
      } }, icon("copy"), h("span", { class: "lbl", text: "Копировать" }));
      kids.push(btn);
    }
    if (msg.cost > 0) kids.push(h("span", { class: "msg-cost", title: "Столько стоил этот ответ по ценам модели (примерно)", text: fmtCost(msg.cost) }));
    msg.foot.replaceChildren.apply(msg.foot, kids);
    msg.foot.hidden = !kids.length;
  }

  function whenLine2(e) {
    return (e.date ? longDay(e.date) : "") + (e.from ? " · " + timeRange(e) : "") +
      (e.remind ? " · напомнить " + (REMIND_LABELS[e.remind] || "") : "") + (e.note ? " · " + e.note : "");
  }
  // What a card ends with once it is answered; "Отменить" while main.js still remembers how to undo it.
  function cardFooter(msg, a, doneText, offText, openPage) {
    if (a.status === "done") {
      return h("div", { class: "act-done" }, icon("check"), h("span", { text: doneText }),
        openPage ? h("button", { type: "button", class: "link-btn", onclick: openPage }, "Открыть") : null,
        a.undoable ? h("button", { type: "button", class: "link-btn", onclick: function () { undoAction(msg, a); } }, "Отменить") : null);
    }
    if (a.status === "undone") return h("div", { class: "act-done off" }, h("span", { text: "Отменено, всё вернул как было" }));
    if (a.status === "canceled") return h("div", { class: "act-done off" }, h("span", { text: offText }));
    if (a.status === "failed") return h("div", { class: "act-done bad" }, h("span", { text: a.error || "Не получилось" }));
    if (a.status === "stale") return h("div", { class: "act-done off" }, h("span", { text: "Карточка устарела. Попросите ассистента ещё раз, если нужно" }));
    return null;
  }
  function calendarCard(msg, a) {
    var e = a.event || {};
    var kind = a.kind === "calendar-add" ? "add" : a.kind === "calendar-update" ? "update" : "delete";
    var k = kindOfEvent(e);
    var head = { add: "Добавить в календарь «", update: "Изменить в календаре «", delete: "Удалить из календаря «" }[kind] + (e.title || a.title) + "»?";
    var kids = [
      h("div", { class: "act-head" }, h("span", { class: "ico", html: kind === "delete" ? ICONS.trash : ICONS.calendar, "aria-hidden": "true" }), h("span", { text: head })),
      h("div", { class: "act-meta" }, h("span", { class: "chip ev-" + k.id, text: k.label }))
    ];
    if (kind === "update" && a.prev) {
      kids.push(h("div", { class: "act-when was", text: "Было: " + whenLine2(a.prev) }), h("div", { class: "act-when", text: "Станет: " + whenLine2(e) }));
    } else kids.push(h("div", { class: "act-when", text: whenLine2(e) }));
    var done = { add: "Дело добавлено в календарь", update: "Дело изменено", delete: "Дело удалено из календаря" }[kind];
    var foot = cardFooter(msg, a, done, "Отменено, календарь не изменился", kind === "delete" ? null : function () { openCalendarDay(e.date); });
    kids.push(foot || cardButtons(msg, a, { add: "Добавить", update: "Изменить", delete: "Удалить" }[kind], kind === "delete"));
    return h("div", { class: "act-card" + (a.status && a.status !== "busy" ? " settled" : "") }, kids);
  }
  function cardButtons(msg, a, label, danger) {
    var busy = a.status === "busy";
    return h("div", { class: "act-buttons" },
      h("button", { type: "button", class: "btn " + (danger ? "btn-danger" : "btn-primary"), disabled: busy, onclick: function () { decide(msg, a, true); } }, busy ? "Секунду…" : label),
      h("button", { type: "button", class: "btn btn-ghost", disabled: busy, onclick: function () { decide(msg, a, false); } }, "Отмена"));
  }
  var TASK_COLUMNS = { todo: "Предстоит", doing: "В процессе", done: "Готово" };
  function taskCard(msg, a) {
    var t = a.task || {};
    var kind = a.kind === "task-add" ? "add" : a.kind === "task-update" ? "update" : "delete";
    var head = { add: "Добавить задачу «", update: "Изменить задачу «", delete: "Удалить задачу «" }[kind] + (t.title || a.title) + "»?";
    var kids = [h("div", { class: "act-head" }, h("span", { class: "ico", html: kind === "delete" ? ICONS.trash : ICONS.tasks, "aria-hidden": "true" }), h("span", { text: head }))];
    if (kind === "update" && a.prevTask) {
      kids.push(h("div", { class: "act-when was", text: "Было: «" + a.prevTask.title + "», " + (TASK_COLUMNS[a.prevTask.status] || "") }),
        h("div", { class: "act-when", text: "Станет: «" + t.title + "», " + (TASK_COLUMNS[t.status] || "") }));
    } else kids.push(h("div", { class: "act-when", text: "Столбец «" + (TASK_COLUMNS[t.status] || "Предстоит") + "»" + (t.note ? " · " + t.note : "") }));
    var done = { add: "Задача добавлена", update: "Задача изменена", delete: "Задача удалена" }[kind];
    var foot = cardFooter(msg, a, done, "Отменено, задачи не изменились", kind === "delete" ? null : function () { setPage("tasks"); });
    kids.push(foot || cardButtons(msg, a, { add: "Добавить", update: "Изменить", delete: "Удалить" }[kind], kind === "delete"));
    return h("div", { class: "act-card" + (a.status && a.status !== "busy" ? " settled" : "") }, kids);
  }
  function actionCard(msg, a) {
    if (/^calendar-/.test(a.kind)) return calendarCard(msg, a);
    if (/^task-/.test(a.kind)) return taskCard(msg, a);
    var cat = categoryOf(a.category);
    var kids = [
      h("div", { class: "act-head" }, icon("spark"), h("span", { text: "Создать промт «" + a.title + "»?" })),
      h("div", { class: "act-meta" }, h("span", { class: "chip " + catClass(a.category) }, cat ? cat.label : a.category || "Без типа")),
      h("div", { class: "act-text", text: a.text })
    ];
    var foot = cardFooter(msg, a, "Промт сохранён в таблицу", "Отменено, ничего не сохранено", function () { setPage("prompts"); });
    if (foot) kids.push(foot);
    else {
      var busy = a.status === "busy";
      kids.push(h("div", { class: "act-buttons" },
        h("button", { type: "button", class: "btn btn-primary", disabled: busy, onclick: function () { decide(msg, a, true); } }, busy ? "Сохраняю…" : "Создать"),
        h("button", { type: "button", class: "btn btn-ghost", disabled: busy, onclick: function () { decide(msg, a, false); } }, "Отмена")));
    }
    return h("div", { class: "act-card" + (a.status && a.status !== "busy" ? " settled" : "") }, kids);
  }
  function renderActions(msg) {
    msg.extra.replaceChildren.apply(msg.extra, msg.actions.map(function (a) { return actionCard(msg, a); }));
  }
  var DONE_TOASTS = {
    "calendar-add": "Дело «%» добавлено в календарь", "calendar-update": "Дело «%» изменено", "calendar-delete": "Дело «%» удалено",
    "task-add": "Задача «%» добавлена", "task-update": "Задача «%» изменена", "task-delete": "Задача «%» удалена", "create-prompt": "Промт «%» добавлен"
  };
  function decide(msg, a, accept) {
    if (a.status) return;
    a.status = "busy";
    renderActions(msg);
    call(api.assistantDecide(a.id, accept)).then(function (r) {
      a.status = r ? (accept ? "done" : "canceled") : null;
      if (r && accept) {
        render();
        toast((DONE_TOASTS[a.kind] || DONE_TOASTS["create-prompt"]).replace("%", a.title));
      }
      renderActions(msg);
      persist(sessionOf(msg));
    });
  }
  function undoAction(msg, a) {
    call(api.assistantUndo(a.id)).then(function (r) {
      a.undoable = false;
      if (r) { a.status = "undone"; render(); toast("Отменено"); }
      renderActions(msg);
      persist(sessionOf(msg));
    });
  }

  function addMessage(role, text, se) {
    se = se || chat;
    if (se === chat) els.chatEmpty.hidden = true;
    if (se === quick) els.qaEmpty.hidden = true;
    var msg = { role: role, text: text || "" };
    if (role === "user") {
      msg.el = h("div", { class: "msg msg-user" }, h("div", { class: "bubble", text: msg.text }));
    } else {
      msg.body = h("div", { class: "msg-body rt" });
      msg.extra = h("div", { class: "msg-extra" });
      msg.foot = h("div", { class: "msg-foot", hidden: true });
      msg.actions = [];
      msg.el = h("div", { class: "msg msg-bot" },
        h("span", { class: "bot-mark", html: ICONS.spark, "aria-hidden": "true" }),
        h("div", { class: "msg-main" }, msg.body, msg.extra, msg.foot));
    }
    se.messages.push(msg);
    se.box.append(msg.el);
    return msg;
  }

  // The send button turns into "stop" while the answer is written: in the LLM tab on screen or in the small window.
  function showBusy(se) {
    var busy = !!se.current;
    if (se.quick) {
      els.qaForm.classList.toggle("busy", busy);
      els.qaSend.setAttribute("aria-label", busy ? "Остановить ответ" : "Отправить");
      els.qaSend.title = els.qaSend.getAttribute("aria-label");
    } else if (se === chat) {
      els.composer.classList.toggle("busy", busy);
      els.chatSend.setAttribute("aria-label", busy ? "Остановить ответ" : "Отправить");
      els.chatSend.title = els.chatSend.getAttribute("aria-label");
    }
  }
  function finish(msg, note, failed) {
    var se = sessionOf(msg);
    msg.streaming = false;
    msg.note = note || "";
    msg.failed = !!failed;
    if (se && se.current === msg) { se.current = null; se.streamId = null; }
    renderBody(msg);
    renderFoot(msg);
    if (!se) return;
    showBusy(se);
    persist(se);
    renderTabs();
  }

  // What main.js gets: finished messages only, without the empty answers that failed or were stopped at once.
  function cardOutcome(a) {
    var e = a.event || {}, t = a.task || {};
    var what = a.kind === "calendar-add" ? "Добавить в календарь «" + e.title + "» " + e.date + " " + timeRange(e)
      : a.kind === "calendar-update" ? "Изменить дело «" + e.title + "»: теперь " + e.date + " " + timeRange(e)
      : a.kind === "calendar-delete" ? "Удалить из календаря «" + e.title + "» " + e.date + " " + timeRange(e)
      : a.kind === "task-add" ? "Добавить задачу «" + t.title + "» в «" + (TASK_COLUMNS[t.status] || "") + "»"
      : a.kind === "task-update" ? "Изменить задачу «" + t.title + "»: столбец «" + (TASK_COLUMNS[t.status] || "") + "»"
      : a.kind === "task-delete" ? "Удалить задачу «" + t.title + "»"
      : "Создать промт «" + a.title + "»";
    var how = a.status === "done" ? "сделано" : a.status === "canceled" ? "пользователь отменил" : a.status === "undone" ? "сделано, но пользователь отменил"
      : a.status === "failed" ? "не получилось" : "пользователь не ответил";
    return "[Карточка: " + what + " — " + how + "]";
  }
  function history(se) {
    return (se || chat).messages.filter(function (m) { return (m.text || (m.actions && m.actions.length)) && !m.streaming; }).map(function (m) {
      var content = m.text;
      if (m.actions && m.actions.length) content = (content ? content + "\n\n" : "") + m.actions.map(cardOutcome).join("\n");
      return { role: m.role, content: content };
    });
  }
  function startReply(se) {
    var msg = addMessage("assistant", "", se);
    msg.streaming = true;
    renderBody(msg);
    se.current = msg;
    se.streamId = null;
    se.waiting = true;
    se.early = [];
    showBusy(se);
    scrollChat(se);
    renderTabs();
    api.assistantSend(history(se), se.quick ? { quick: true } : undefined).then(function (r) {
      se.waiting = false;
      if (se.current !== msg) return;
      if (!r || !r.ok) { finish(msg, (r && r.error) || "Ассистент не ответил. Попробуйте ещё раз.", true); return; }
      se.streamId = r.id;
      var early = se.early;
      se.early = [];
      early.forEach(onAssistantEvent);
    }, function () {
      se.waiting = false;
      if (se.current === msg) finish(msg, "Ассистент не ответил. Попробуйте ещё раз.", true);
    });
  }
  function newChatId() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function sendChat(text, se) {
    se = se || chat;
    text = String(text || "").replace(/\s+$/, "");
    if (!text.trim() || se.current) return;
    if (!se.id) {
      se.id = newChatId();
      se.title = text.trim().replace(/\s+/g, " ").slice(0, 70);
    }
    addMessage("user", text, se);
    persist(se);
    if (se.quick) els.qaInput.value = "";
    else if (se === chat) { els.chatInput.value = ""; growInput(); }
    startReply(se);
    if (!se.quick) saveTabs();
  }
  function stopChat(se) {
    se = se || chat;
    var msg = se.current;
    if (!msg) return;
    if (se.streamId) api.assistantStop(se.streamId);
    finish(msg, "Ответ остановлен");
  }
  function retry(msg) {
    var se = sessionOf(msg);
    var i = se ? se.messages.indexOf(msg) : -1;
    if (i === -1 || se.current) return;
    se.messages.splice(i, 1);
    msg.el.remove();
    startReply(se);
  }
  /* ---------- history ---------- */
  // The conversation as it is saved: text and what the user answered on cards, no page elements.
  function savedMessages(se) {
    return se.messages.filter(function (m) { return !m.streaming && (m.text || m.note || (m.actions && m.actions.length)); }).map(function (m) {
      var out = { role: m.role, text: m.text };
      if (m.note) out.note = m.note;
      if (m.failed) out.failed = true;
      if (m.cost) out.cost = m.cost;
      if (m.actions && m.actions.length) out.actions = m.actions.map(function (a) {
        return { id: a.id, kind: a.kind, title: a.title, category: a.category, text: a.text, status: a.status === "busy" ? null : a.status, event: a.event, prev: a.prev, task: a.task, prevTask: a.prevTask };
      });
      return out;
    });
  }
  function persist(se) {
    se = se || chat;
    if (!se || se.quick || !se.id) return;
    var messages = savedMessages(se);
    if (!messages.length) return;
    api.chatSave({ id: se.id, title: se.title, messages: messages }).then(function (r) {
      if (r && r.ok) { hist.list = r.chats; renderHistory(); renderTabs(); }
    }, function () {});
  }
  // Before another conversation opens in this tab: stop the answer and turn unanswered cards into "устарела".
  function leaveChat(se) {
    se = se || chat;
    if (se.current) stopChat(se);
    se.messages.forEach(function (m) {
      (m.actions || []).forEach(function (a) { if (!a.status || a.status === "busy") a.status = "stale"; });
    });
    persist(se);
  }
  function clearChat(se) {
    se = se || chat;
    se.id = null;
    se.title = "";
    se.messages = [];
    se.current = null;
    se.streamId = null;
    se.waiting = false;
    se.early = [];
    se.loadId = null;
    se.box.replaceChildren();
    if (se === chat) els.chatEmpty.hidden = false;
    if (se === quick) els.qaEmpty.hidden = false;
    showBusy(se);
  }
  // The LLM tab on screen changed: its conversation goes into the page, with what was typed in it.
  function showSession(se) {
    if (chat !== se) chat.draft = els.chatInput.value;
    chat = se;
    se.unread = false;
    els.chat.replaceChildren(els.chatEmpty, se.box);
    els.chatEmpty.hidden = se.messages.length > 0;
    els.chatInput.value = se.draft || "";
    growInput();
    showBusy(se);
    renderHistory();
    setHistoryOpen(false);
    if (se.loadId) { var id = se.loadId; se.loadId = null; loadChatInto(se, id); }
  }
  function newChat() {
    leaveChat(chat);
    clearChat(chat);
    els.chatInput.value = "";
    growInput();
    renderHistory();
    renderTabs();
    saveTabs();
    setHistoryOpen(false);
    els.scroller.scrollTop = 0;
    els.chatInput.focus();
  }
  function loadChatInto(se, id) {
    api.chatGet(id).then(function (r) {
      if (!r || !r.ok) { toast((r && r.error) || "Не получилось открыть разговор."); renderTabs(); return; }
      clearChat(se);
      se.id = r.chat.id;
      se.title = r.chat.title;
      r.chat.messages.forEach(function (m) {
        var msg = addMessage(m.role, m.text, se);
        if (m.role !== "assistant") return;
        msg.note = m.note || "";
        msg.failed = !!m.failed;
        msg.cost = m.cost || 0;
        msg.actions = (m.actions || []).map(function (a) { return Object.assign({}, a); });
        renderBody(msg);
        renderActions(msg);
        renderFoot(msg);
      });
      renderHistory();
      renderTabs();
      saveTabs();
      scrollChat(se);
      if (se === chat) els.chatInput.focus({ preventScroll: true });
    });
  }
  // A conversation from "История": if another tab already shows it, go there; otherwise it replaces this tab's one.
  function openChat(id) {
    if (id === chat.id) { setHistoryOpen(false); return; }
    var at = tabs.list.findIndex(function (t) { return t.session && (t.session.id === id || t.session.loadId === id); });
    if (at !== -1) { activateTab(at); return; }
    leaveChat(chat);
    loadChatInto(chat, id);
    setHistoryOpen(false);
  }
  function removeChat(id) {
    api.chatDelete(id).then(function (r) {
      hist.confirmId = null;
      if (r && r.ok) hist.list = r.chats;
      sessions.forEach(function (se) {
        if (se.id !== id && se.loadId !== id) return;
        if (se.current) stopChat(se);
        clearChat(se);
      });
      renderHistory();
      renderTabs();
      saveTabs();
      toast("Разговор удалён");
    }, function () { toast("Не получилось удалить разговор."); });
  }
  function historyItem(c) {
    if (hist.confirmId === c.id) {
      return h("div", { class: "ch-item confirm" },
        h("span", { text: "Удалить разговор?" }),
        h("button", { type: "button", class: "link-btn danger", onclick: function () { removeChat(c.id); } }, "Удалить"),
        h("button", { type: "button", class: "link-btn", onclick: function () { hist.confirmId = null; renderHistory(); } }, "Отмена"));
    }
    return h("div", { class: "ch-item" },
      h("button", { type: "button", class: "ch-open", "aria-current": c.id === chat.id ? "true" : null, title: c.title, onclick: function () { openChat(c.id); } },
        h("span", { class: "ch-name", text: c.title }), h("span", { class: "ch-when", text: fmtWhen(c.updatedAt) })),
      h("button", { type: "button", class: "ch-del", "aria-label": "Удалить разговор «" + c.title + "»", title: "Удалить разговор", html: ICONS.x,
        onclick: function () { hist.confirmId = c.id; renderHistory(); } }));
  }
  function renderHistory() {
    var kids = hist.list.map(historyItem);
    if (!kids.length) kids = [h("p", { class: "ch-empty", text: "Здесь появятся ваши разговоры с ассистентом." })];
    els.chatList.replaceChildren.apply(els.chatList, kids);
  }
  // In a narrow window the history hides behind the "История" button.
  function setHistoryOpen(open) {
    els.chatHistory.classList.toggle("open", open);
    els.chatHistoryBtn.setAttribute("aria-expanded", String(open));
  }
  function refreshChats() {
    api.chatList().then(function (r) { if (r && r.ok) { hist.list = r.chats; renderHistory(); renderTabs(); } }, function () {});
  }

  // Events come for any session: each answer is found by its stream id.
  function onAssistantEvent(e) {
    if (!e || e.seen) return;
    var se = sessions.find(function (x) { return x.current && x.streamId === e.id; });
    if (!se) {
      // The id is not known yet: keep the event for the sessions still waiting for theirs.
      sessions.forEach(function (x) { if (x.waiting && x.current) x.early.push(e); });
      return;
    }
    e.seen = true;
    var msg = se.current;
    if (e.kind === "open") { openTabsFromAssistant(e.tabs); return; }
    follow(se, function () {
      if (e.kind === "delta") { msg.text += e.text || ""; renderBody(msg); }
      else if (e.kind === "action" && e.action) {
        msg.actions.push(Object.assign({ status: null }, e.action));
        if (e.data) { applyData(e.data); render(); }
        renderActions(msg);
      }
      else if (e.kind === "done") { msg.cost = e.cost || 0; finish(msg); }
      else if (e.kind === "error") { msg.cost = e.cost || 0; finish(msg, e.error || "Ассистент не ответил. Попробуйте ещё раз.", true); }
    });
    if ((e.kind === "done" || e.kind === "error") && e.assistant && state.info) {
      state.info.assistant = e.assistant;
      renderAssistantSettings();
      els.qaModel.textContent = quickModelName();
    }
    if ((e.kind === "done" || e.kind === "error") && !onScreen(se) && !se.quick) { se.unread = true; renderTabs(); renderBadges(); }
    if ((e.kind === "done" || e.kind === "error") && !onScreen(se) && document.hasFocus()) {
      var where = se.quick ? "Ассистент" : "«" + (se.title || "LLM") + "»";
      toast(e.kind === "done" ? where + ": ответ готов" : where + ": не получилось ответить");
    }
  }
  api.onAssistant(onAssistantEvent);
  // A click on the Windows notification about an answer.
  api.onAssistantOpen(function () { setPage("assistant"); scrollChat(); });

  function growInput() {
    var t = els.chatInput;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight + 2, 220) + "px";
    updateCostHint();
  }
  els.chatIdeas.replaceChildren.apply(els.chatIdeas, IDEAS.map(function (idea) {
    return h("button", { type: "button", class: "fchip", onclick: function () { sendChat(idea); } }, idea);
  }));
  els.chatInput.addEventListener("input", growInput);
  els.chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
      e.preventDefault();
      if (!chat.current) sendChat(els.chatInput.value);
    } else if (e.key === "Escape" && chat.current) {
      e.preventDefault();
      stopChat();
    }
  });
  els.composer.addEventListener("submit", function (e) {
    e.preventDefault();
    if (chat.current) stopChat(); else sendChat(els.chatInput.value);
    els.chatInput.focus();
  });
  els.chatNew.addEventListener("click", newChat);
  els.chatHistoryBtn.addEventListener("click", function () { setHistoryOpen(!els.chatHistory.classList.contains("open")); });
  refreshChats();

  /* ---------- the small assistant window ---------- */
  // Opens above the profile button for quick errands (calendar, tasks, tabs) and hides again.
  // main.js answers it with the cheapest model and quick thinking; "Открыть в LLM" moves the conversation into a tab.
  els.qaList.replaceChildren(els.qaEmpty, quick.box);
  function quickModelName() {
    var a = state.info && state.info.assistant, id = a && a.quickModel;
    var m = id ? MODELS.find(function (x) { return x.id === id; }) : null;
    return m ? m.name + " · Быстро" : "Заглушка · ключа нет";
  }
  function setQuick(open) {
    els.qa.hidden = !open;
    els.qaBtn.setAttribute("aria-expanded", String(open));
    if (!open) return;
    els.qaModel.textContent = quickModelName();
    scrollChat(quick);
    els.qaInput.focus();
  }
  els.qaIdeas.replaceChildren.apply(els.qaIdeas, QUICK_IDEAS.map(function (idea) {
    return h("button", { type: "button", class: "fchip", onclick: function () { sendChat(idea, quick); } }, idea);
  }));
  els.qaBtn.addEventListener("click", function () { setQuick(els.qa.hidden); });
  els.qaClose.addEventListener("click", function () { setQuick(false); els.qaBtn.focus(); });
  els.qaNew.addEventListener("click", function () { if (quick.current) stopChat(quick); clearChat(quick); els.qaInput.focus(); });
  els.qaFull.addEventListener("click", function () {
    setQuick(false);
    if (!quick.messages.length) { openTab("assistant", { fresh: true }); return; }
    // The conversation goes on in a tab of its own (and into "История"); the small window starts clean.
    var se = quick;
    se.quick = false;
    quick = newSession(true);
    els.qaList.replaceChildren(els.qaEmpty, quick.box);
    els.qaEmpty.hidden = false;
    showBusy(quick);
    persist(se);
    openTab("assistant", { session: se });
  });
  els.qaForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (quick.current) stopChat(quick); else sendChat(els.qaInput.value, quick);
    els.qaInput.focus();
  });
  els.qaInput.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (quick.current) stopChat(quick); else { setQuick(false); els.qaBtn.focus(); }
  });
  // A click elsewhere hides the window; an answer still being written keeps coming.
  document.addEventListener("mousedown", function (e) {
    if (!els.qa.hidden && !els.qa.contains(e.target) && !els.qaBtn.contains(e.target) && !e.target.closest("dialog")) setQuick(false);
  });

  /* ---------- assistant settings ---------- */
  // Keys themselves never come back from main.js: the page only knows which ones are saved.
  var PROVIDERS = {
    openai: { name: "ChatGPT", owner: "OpenAI" },
    anthropic: { name: "Claude", owner: "Anthropic" }
  };
  var MODELS = [
    // In the menu the strongest model of each service is on top, the weakest at the bottom.
    { id: "gpt-6-astra", provider: "openai", name: "GPT-6 Astra", short: "GPT-6 Astra", text: "Самая сильная и самая дорогая" },
    { id: "gpt-6.1-sol", provider: "openai", name: "GPT-6.1 Sol", short: "GPT-6.1 Sol", text: "Основная: почти как Astra, но в 5 раз дешевле" },
    { id: "gpt-6-luna", provider: "openai", name: "GPT-6 Luna", short: "GPT-6 Luna", text: "Самая дешёвая, в 20 раз дешевле Sol. Для проверок" },
    { id: "claude-opus-5-5", provider: "anthropic", name: "Claude Opus 5.5", short: "Opus 5.5", text: "Лучше всего пишет и улучшает промты" },
    { id: "claude-haiku-5-5", provider: "anthropic", name: "Claude Haiku 5.5", short: "Haiku 5.5", text: "Быстрая и примерно в 40 раз дешевле Opus" }
  ];
  // How long the model thinks before answering (reasoning effort in the API). Deeper is slower and costs more.
  // out: how many tokens an answer usually takes at this level, thinking included (for the price estimate).
  var EFFORTS = [
    { id: "low", name: "Быстро", text: "Почти не раздумывает, дешевле всего", out: 500 },
    { id: "medium", name: "Средне", text: "Подходит для большинства задач", badge: "Рекомендуется", out: 1500 },
    { id: "high", name: "Глубоко", text: "Для сложных промтов и разборов", out: 3500 },
    { id: "xhigh", name: "Очень глубоко", text: "Дольше и дороже", warn: "≈2× дороже", out: 7000 },
    { id: "max", name: "Максимум", text: "Самый медленный и дорогой", warn: "3–5× дороже", out: 12000 }
  ];
  function byId(list, id) { return list.find(function (x) { return x.id === id; }) || null; }
  function assistantState() { return (state.info && state.info.assistant) || { keys: {} }; }
  function hasKeyFor(provider) { return !!assistantState().keys[provider]; }

  // One card per service on the settings page: status, key field, "Проверить ключ" and "Удалить ключ".
  var keyCards = Array.prototype.slice.call(document.querySelectorAll(".set-provider")).map(function (card) {
    return {
      provider: card.dataset.provider, card: card,
      status: card.querySelector(".set-status"), form: card.querySelector(".set-key"), input: card.querySelector(".set-key-input"),
      check: card.querySelector(".set-check"), del: card.querySelector(".set-delete"), msg: card.querySelector(".set-msg"),
      spend: card.querySelector(".set-spend"), spendLine: card.querySelector(".set-spend-line"),
      balForm: card.querySelector(".set-balance"), balInput: card.querySelector(".set-bal-input"), balMsg: card.querySelector(".set-bal-msg")
    };
  });
  function keyCard(provider) { return keyCards.find(function (c) { return c.provider === provider; }); }
  function goToKey(provider) {
    openSettings("keys");
    var c = keyCard(provider || "openai");
    if (!c) return;
    try { c.card.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" }); } catch (e) {}
    c.input.focus({ preventScroll: true });
  }

  // The price of one answer: they are often fractions of a cent.
  function fmtCost(n) {
    if (!(n > 0)) return "$0";
    if (n < 0.001) return "меньше $0.001";
    return "$" + (n < 0.1 ? n.toFixed(3) : n.toFixed(2));
  }
  function fmtUsd(n) {
    if (!(n > 0)) return "$0";
    if (n < 0.01) return "меньше $0.01";
    return "$" + n.toFixed(2).replace(/\.00$/, "");
  }
  function renderAssistantSettings() {
    els.qaModel.textContent = quickModelName();
    var a = state.info && state.info.assistant;
    if (!a) return;
    var model = byId(MODELS, a.model), effort = byId(EFFORTS, a.effort);
    var sp = model && a.spend && a.spend[model.provider];
    els.chatMode.hidden = a.hasKey;
    els.chatMeta.hidden = !a.hasKey;
    els.chatMeta.textContent = a.hasKey ? "Отвечает " + (model ? model.name : a.model) +
      (sp && sp.left !== null ? " · на счёте осталось примерно " + fmtUsd(sp.left) : "") + "." : "";
    els.setNotify.checked = a.notify !== false;
    els.setConfirm.checked = a.confirm !== false;
    els.modelBtnText.textContent = a.hasKey ? (model ? model.short : a.model) + " · " + (effort ? effort.name : a.effort) : "Заглушка · " + (effort ? effort.name : a.effort);
    if (!els.modelMenu.hidden) renderModelMenu();
    updateCostHint();
    keyCards.forEach(function (c) {
      var has = !!a.keys[c.provider];
      c.status.textContent = has ? "Ключ сохранён" : "Ключа нет";
      c.status.classList.toggle("on", has);
      c.del.hidden = !has;
      c.input.placeholder = has ? "Ключ сохранён. Вставьте новый, чтобы заменить" : c.input.dataset.placeholder;
      var sp = (a.spend && a.spend[c.provider]) || { month: 0, amount: null, left: null };
      c.spend.hidden = !has && !(sp.month > 0);
      var line = ["Потрачено через Snowball в этом месяце: ", h("b", { text: "≈ " + fmtUsd(sp.month) })];
      if (sp.amount !== null) line.push(" · На счёте осталось примерно ", h("b", { text: fmtUsd(sp.left) }), " из " + fmtUsd(sp.amount));
      c.spendLine.replaceChildren.apply(c.spendLine, line);
      if (document.activeElement !== c.balInput) c.balInput.value = sp.amount !== null ? String(sp.amount).replace(".", ",") : "";
    });
  }

  /* ---------- "Модель" button in the message box ---------- */
  var effortOpen = false;
  var effortTimer = null;
  function modelOption(item, checked, onpick) {
    return h("button", { type: "button", class: "mm-item", role: "menuitemradio", "aria-checked": String(checked), onclick: onpick },
      h("span", { class: "mm-text" },
        h("span", { class: "mm-name" }, item.name,
          item.badge ? h("span", { class: "mm-badge", text: item.badge }) : null,
          item.warn ? h("span", { class: "mm-warn", text: item.warn }) : null),
        h("span", { class: "mm-sub", text: item.text })),
      h("span", { class: "mm-tick", html: ICONS.check, "aria-hidden": "true" }));
  }
  function renderModelMenu() {
    var a = assistantState();
    var kids = [];
    if (!a.hasKey) {
      kids.push(h("div", { class: "mm-note" }, "Сейчас отвечает заглушка. Модели появятся здесь, когда добавите ключ ChatGPT или Claude. ",
        h("button", { type: "button", class: "link-btn", onclick: function () { setModelMenu(false); goToKey("openai"); } }, "Подключить")));
    }
    // Only the services with a saved key.
    Object.keys(PROVIDERS).filter(hasKeyFor).forEach(function (pr, i) {
      if (i) kids.push(h("hr"));
      kids.push(h("div", { class: "mm-label", text: PROVIDERS[pr].name }));
      MODELS.filter(function (m) { return m.provider === pr; }).forEach(function (m) {
        kids.push(modelOption(m, m.id === a.model, function () { pickOption("model", m); }));
      });
    });
    var effort = byId(EFFORTS, a.effort) || EFFORTS[1];
    if (kids.length) kids.push(h("hr"));
    var list = h("div", { class: "menu submenu mm-efforts", role: "menu", "aria-label": "Размышления" },
      EFFORTS.map(function (e) { return modelOption(e, e.id === a.effort, function () { pickOption("effort", e); }); }));
    var row = h("button", { type: "button", class: "mm-item has-sub", "aria-haspopup": "true", "aria-expanded": String(effortOpen),
      onclick: function () { effortOpen = !effortOpen; wrap.classList.toggle("open", effortOpen); row.setAttribute("aria-expanded", String(effortOpen)); if (effortOpen) { fitSubmenu(list); focusEffort(); } } },
      h("span", { class: "mm-text" }, h("span", { class: "mm-name", text: "Размышления" })),
      h("span", { class: "sub-value", text: effort.name }),
      h("span", { class: "sub-chev", html: ICONS.right, "aria-hidden": "true" }));
    var wrap = h("div", { class: "sub-wrap" + (effortOpen ? " open" : "") }, row, list);
    // Like the profile menu: the list stays open for a moment after the mouse leaves, so it can be reached.
    wrap.addEventListener("mouseenter", function () { clearTimeout(effortTimer); effortOpen = true; wrap.classList.add("open"); row.setAttribute("aria-expanded", "true"); fitSubmenu(list); });
    wrap.addEventListener("mouseleave", function () {
      clearTimeout(effortTimer);
      effortTimer = setTimeout(function () {
        if (wrap.contains(document.activeElement) && document.activeElement !== row) return;
        effortOpen = false; wrap.classList.remove("open"); row.setAttribute("aria-expanded", "false");
      }, 350);
    });
    kids.push(wrap);
    els.modelMenu.replaceChildren.apply(els.modelMenu, kids);
  }
  function focusEffort() { var f = els.modelMenu.querySelector('.mm-efforts [aria-checked="true"]') || els.modelMenu.querySelector(".mm-efforts button"); if (f) f.focus(); }
  function setModelMenu(open) {
    if (!open) effortOpen = false;
    if (open) renderModelMenu();
    els.modelMenu.hidden = !open;
    els.modelBtn.setAttribute("aria-expanded", String(open));
    if (open) { var c = els.modelMenu.querySelector(':scope > .mm-item[aria-checked="true"]') || els.modelMenu.querySelector(".mm-item"); if (c) c.focus(); }
  }
  // The menu stays open, so model and thinking can be picked one after the other, like in Claude.
  function pickOption(kind, item) {
    var opts = {};
    opts[kind] = item.id;
    call(api.assistantSetOptions(opts)).then(function (r) {
      if (!r) return;
      renderAssistantSettings();
      renderModelMenu();
      updateCostHint();
      var f = Array.prototype.find.call(els.modelMenu.querySelectorAll(".mm-item"), function (b) { var n = b.querySelector(".mm-name"); return n && n.firstChild && n.firstChild.textContent === item.name; });
      if (f) f.focus();
    });
  }
  els.modelBtn.addEventListener("click", function () { setModelMenu(els.modelMenu.hidden); });
  document.addEventListener("mousedown", function (e) {
    if (!els.modelMenu.hidden && !els.modelMenu.contains(e.target) && !els.modelBtn.contains(e.target)) setModelMenu(false);
  });
  els.modelMenu.addEventListener("keydown", function (e) {
    var inList = document.activeElement && document.activeElement.closest(".mm-efforts");
    var items = Array.prototype.slice.call(els.modelMenu.querySelectorAll(inList ? ".mm-efforts .mm-item" : ":scope > .mm-item, :scope > .sub-wrap > .mm-item"));
    var i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setModelMenu(false); els.modelBtn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === "ArrowRight" && document.activeElement.classList.contains("has-sub")) { e.preventDefault(); document.activeElement.click(); }
    else if (e.key === "ArrowLeft" && inList) { e.preventDefault(); effortOpen = false; var w = inList.closest(".sub-wrap"); w.classList.remove("open"); w.querySelector(".has-sub").focus(); }
  });

  /* ---------- price estimate before sending ---------- */
  // A rough guess from the length of the conversation (about 3 characters per token for Russian text) and the
  // usual length of an answer at the chosen thinking level. The exact price appears under the answer.
  function estimateCost() {
    var a = assistantState();
    if (!a.hasKey || !a.prices) return 0;
    var price = a.prices[a.model], effort = byId(EFFORTS, a.effort) || EFFORTS[1];
    if (!price) return 0;
    var chars = (a.fixedChars || 0) + els.chatInput.value.length;
    chat.messages.forEach(function (m) { chars += (m.text || "").length; });
    return (chars / 3 * price.input + effort.out * price.output) / 1e6;
  }
  function updateCostHint() {
    var n = estimateCost();
    els.chatCost.hidden = !(n > 0);
    els.chatCost.textContent = n > 0 ? "≈ " + fmtCost(n) + " за ответ" : "";
  }
  els.chatInput.addEventListener("input", updateCostHint);

  keyCards.forEach(function (c) {
    var name = PROVIDERS[c.provider].name;
    var say = function (text, neutral) { c.msg.textContent = text || ""; c.msg.classList.toggle("neutral", !!neutral); };
    c.form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (c.check.disabled) return;
      var key = c.input.value.trim();
      if (!key && !hasKeyFor(c.provider)) { say("Вставьте ключ в поле."); c.input.focus(); return; }
      c.check.disabled = true;
      say("Проверяю ключ, это займёт пару секунд…", true);
      api.assistantCheckKey(c.provider, key).then(function (r) {
        c.check.disabled = false;
        if (!r || !r.ok) { say((r && r.error) || "Не получилось проверить ключ. Попробуйте ещё раз."); return; }
        state.info = r.info;
        c.input.value = "";
        render();
        if (r.warning) say((r.saved ? "Ключ сохранён, но " : "Ключ верный, но ") + r.warning.charAt(0).toLowerCase() + r.warning.slice(1));
        else say(r.saved ? "Ключ работает и сохранён. Теперь в «Ассистенте» можно выбрать " + name + " кнопкой «Модель»." : "Ключ работает.", true);
      }, function () {
        c.check.disabled = false;
        say("Не получилось проверить ключ. Попробуйте ещё раз.");
      });
    });
    c.del.addEventListener("click", function () {
      call(api.assistantDeleteKey(c.provider)).then(function (r) {
        if (!r) return;
        render();
        say(assistantState().hasKey ? "Ключ удалён." : "Ключ удалён. Ассистент снова отвечает заглушкой.", true);
      });
    });
    c.input.addEventListener("input", function () { if (c.msg.textContent) say(""); });
    // How much the user put on the account: from now on the program subtracts what its answers cost.
    c.balForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = c.balInput.value.trim();
      api.assistantSetBalance(c.provider, v === "" ? null : v).then(function (r) {
        c.balMsg.classList.toggle("neutral", !!(r && r.ok));
        if (!r || !r.ok) { c.balMsg.textContent = (r && r.error) || "Не получилось сохранить."; return; }
        state.info = r.info;
        c.balInput.blur();
        render();
        c.balMsg.textContent = v === "" ? "Сумма забыта." : "Запомнил. Дальше программа будет вычитать из неё стоимость ответов.";
      }, function () { c.balMsg.textContent = "Не получилось сохранить."; });
    });
    c.balInput.addEventListener("input", function () { c.balMsg.textContent = ""; });
  });
  els.setConfirm.addEventListener("change", function () {
    call(api.setConfirm(els.setConfirm.checked)).then(function (r) { if (r) renderAssistantSettings(); });
  });
  els.setNotify.addEventListener("change", function () {
    call(api.setNotify(els.setNotify.checked)).then(function (r) { if (r) renderAssistantSettings(); });
  });
  els.chatConnect.addEventListener("click", function () { goToKey("openai"); });

  /* ---------- tasks board (alpha) ---------- */
  // Three columns: «Предстоит», «В процессе», «Готово». Cards are added at the bottom of a column,
  // dragged between columns (or up and down), renamed by a double click. Stored in tasks.json.
  var TASK_COLS = [{ id: "todo", name: "Предстоит" }, { id: "doing", name: "В процессе" }, { id: "done", name: "Готово" }];
  var tb = { adding: null, editing: null, confirmDel: null, dragId: null, focus: false };
  function findTask(id) { return state.tasks.find(function (t) { return t.id === id; }) || null; }
  function sortTasks() {
    var col = { todo: 0, doing: 1, done: 2 };
    state.tasks.sort(function (a, b) { return col[a.status] - col[b.status] || a.order - b.order; });
  }
  function saveTaskNow(t) { return call(api.taskSave(t)).then(function (r) { render(); return r; }); }
  function renderTasks() {
    var all = state.tasks || [];
    var done = all.filter(function (t) { return t.status === "done"; }).length;
    els.tasksMeta.textContent = all.length ? all.length + " " + plural(all.length, "задача", "задачи", "задач") + (done ? ", готово " + done : "") : "Пока задач нет: добавьте первую в столбец «Предстоит»";
    els.board.replaceChildren.apply(els.board, TASK_COLS.map(function (c) {
      var list = all.filter(function (t) { return t.status === c.id; });
      var col = h("section", { class: "tcol tc-" + c.id, "aria-label": c.name },
        h("div", { class: "tcol-h" }, h("span", { class: "tcol-name" }, h("i", { "aria-hidden": "true" }), c.name), h("span", { class: "tcol-n", text: String(list.length) })),
        list.map(taskItem), addRow(c.id));
      col.addEventListener("dragover", function (e) { if (!tb.dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; col.classList.add("drop"); });
      col.addEventListener("dragleave", function (e) { if (!col.contains(e.relatedTarget)) col.classList.remove("drop"); });
      col.addEventListener("drop", function (e) {
        if (!tb.dragId) return;
        e.preventDefault();
        col.classList.remove("drop");
        dropTask(c.id, e.target.closest(".task[data-id]"), list);
      });
      return col;
    }));
    if (tb.focus) {
      tb.focus = false;
      var inp = els.board.querySelector(".task-input");
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }
  }
  // Dropped on a card: goes right above it; on the empty part of a column: to its bottom.
  function dropTask(status, targetEl, list) {
    var id = tb.dragId;
    tb.dragId = null;
    var task = findTask(id);
    if (!task) return;
    var rest = list.filter(function (t) { return t.id !== id; });
    var order;
    if (targetEl) {
      if (targetEl.dataset.id === id) return;
      var target = findTask(targetEl.dataset.id), at = rest.indexOf(target), before = rest[at - 1];
      order = before ? (before.order + target.order) / 2 : target.order - 1;
    } else {
      if (task.status === status && rest.length && rest[rest.length - 1].order < task.order) return;
      order = rest.length ? rest[rest.length - 1].order + 1 : Date.now();
    }
    task.status = status;
    task.order = order;
    sortTasks();
    renderTasks();
    saveTaskNow({ id: id, status: status, order: order });
  }
  function taskItem(t) {
    if (tb.editing === t.id) {
      var area = h("textarea", { class: "task-input", rows: "2", maxlength: "300", "aria-label": "Название задачи" });
      area.value = t.title;
      var finishEdit = function (save) {
        if (tb.editing !== t.id) return;
        tb.editing = null;
        var v = area.value.trim();
        if (save && v && v !== t.title) { t.title = v; saveTaskNow({ id: t.id, title: v }); } else renderTasks();
      };
      area.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finishEdit(true); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finishEdit(false); }
      });
      area.addEventListener("blur", function () { finishEdit(true); });
      return h("div", { class: "task editing" }, area);
    }
    if (tb.confirmDel === t.id) {
      return h("div", { class: "task confirm" }, h("span", { text: "Удалить «" + t.title + "»?" }),
        h("button", { type: "button", class: "link-btn danger", onclick: function () {
          tb.confirmDel = null;
          state.tasks = state.tasks.filter(function (x) { return x.id !== t.id; });
          renderTasks();
          call(api.taskDelete(t.id)).then(function () { render(); });
        } }, "Удалить"),
        h("button", { type: "button", class: "link-btn", onclick: function () { tb.confirmDel = null; renderTasks(); } }, "Отмена"));
    }
    var edit = function () { tb.editing = t.id; tb.focus = true; renderTasks(); };
    var el = h("div", { class: "task", draggable: "true", "data-id": t.id, title: "Перетащите в другой столбец. Двойной клик — изменить", ondblclick: edit },
      h("span", { class: "task-t", text: t.title }),
      t.note ? h("span", { class: "task-note", text: t.note }) : null,
      h("span", { class: "task-acts" },
        h("button", { type: "button", class: "task-btn", title: "Изменить", "aria-label": "Изменить задачу «" + t.title + "»", html: ICONS.pencil, onclick: edit }),
        h("button", { type: "button", class: "task-btn", title: "Удалить", "aria-label": "Удалить задачу «" + t.title + "»", html: ICONS.trash,
          onclick: function () { tb.confirmDel = t.id; renderTasks(); } })));
    el.addEventListener("dragstart", function (e) {
      tb.dragId = t.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", t.title);
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", function () {
      tb.dragId = null;
      el.classList.remove("dragging");
      els.board.querySelectorAll(".tcol.drop").forEach(function (c) { c.classList.remove("drop"); });
    });
    return el;
  }
  // "+ Новая задача": Enter adds it and keeps the field open for the next one; Esc or an empty field closes it.
  function addRow(status) {
    if (tb.adding !== status) {
      return h("button", { type: "button", class: "task-add", onclick: function () { tb.adding = status; tb.focus = true; renderTasks(); } }, icon("plus"), "Новая задача");
    }
    var inp = h("textarea", { class: "task-input", rows: "2", maxlength: "300", placeholder: "Что нужно сделать? Enter — добавить", "aria-label": "Новая задача" });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        var v = inp.value.trim();
        if (!v) { tb.adding = null; renderTasks(); return; }
        tb.focus = true;
        inp.value = "";
        saveTaskNow({ title: v, status: status });
      } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); tb.adding = null; renderTasks(); }
    });
    inp.addEventListener("blur", function () {
      setTimeout(function () {
        if (tb.adding !== status || document.activeElement && document.activeElement.classList.contains("task-input")) return;
        var v = inp.value.trim();
        tb.adding = null;
        if (v) saveTaskNow({ title: v, status: status }); else renderTasks();
      }, 120);
    });
    return inp;
  }

  // The generator is not there yet: the two buttons show what is coming.
  document.querySelectorAll(".gen-card").forEach(function (b) {
    b.addEventListener("click", function () {
      toast(b.dataset.gen === "video" ? "Генерация видео появится в следующих версиях. Пока это пример." : "Генерация картинок появится в следующих версиях. Пока это пример.", true);
    });
  });

  /* ---------- drag and drop ---------- */
  function hasFiles(e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    return !!t && Array.prototype.indexOf.call(t, "Files") !== -1;
  }
  function setDropRow(id) {
    if (state.dropRowId === id) return;
    var prev = state.dropRowId && els.rows.querySelector('tr[data-id="' + state.dropRowId + '"]');
    if (prev) prev.classList.remove("drop-target");
    state.dropRowId = id;
    var next = id && els.rows.querySelector('tr[data-id="' + id + '"]');
    if (next) next.classList.add("drop-target");
  }
  var dragDepth = 0;
  function clearDrag() {
    dragDepth = 0;
    setDropRow(null);
    els.editor.classList.remove("drop-over");
  }
  document.addEventListener("dragenter", function (e) { if (hasFiles(e)) dragDepth++; });
  document.addEventListener("dragleave", function (e) { if (hasFiles(e) && --dragDepth <= 0) clearDrag(); });
  document.addEventListener("dragover", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    var inEditor = state.editorOpen && els.editor.contains(e.target);
    var tr = !inEditor && e.target.closest ? e.target.closest("tr[data-id]:not(.editing)") : null;
    e.dataTransfer.dropEffect = inEditor || tr ? "copy" : "none";
    els.editor.classList.toggle("drop-over", inEditor);
    setDropRow(tr ? tr.dataset.id : null);
  });
  document.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    var archive = Array.prototype.find.call(e.dataTransfer.files || [], function (f) { return /\.(snowprompt|snowball)$/i.test(f.name); });
    if (archive) { clearDrag(); var ap = api.pathForFile(archive); if (ap) openArchive(ap); return; }
    var inEditor = state.editorOpen && els.editor.contains(e.target);
    var tr = !inEditor && e.target.closest ? e.target.closest("tr[data-id]:not(.editing)") : null;
    var files = e.dataTransfer.files;
    clearDrag();
    if (!files || !files.length) return;
    if (inEditor) { filesToSources(files).then(addToDraft); return; }
    if (tr) {
      filesToSources(files).then(function (list) { attachToPrompt(tr.dataset.id, list.map(function (p) { return p.source; })); });
      return;
    }
    toast(state.editorOpen ? "Отпустите файл над формой промта" : "Отпустите файл над строкой нужного промта");
  });

  // Ctrl + V with a picture in the clipboard while the editor is open adds it as a file.
  els.editor.addEventListener("paste", function (e) {
    var cd = e.clipboardData;
    if (!cd || !cd.files || !cd.files.length) return;
    var types = Array.prototype.slice.call(cd.types || []);
    if (types.indexOf("text/plain") !== -1 && (e.target === els.fText || e.target === els.fTitle)) return;
    e.preventDefault();
    filesToSources(cd.files, true).then(function (list) {
      addToDraft(list);
      toast(list.length > 1 ? "Картинки добавлены, нажмите «Сохранить»" : "Картинка добавлена, нажмите «Сохранить»");
    });
  });

  /* ---------- events ---------- */
  buildCategoryPicker();
  els.addBtn.addEventListener("click", function () { openEditor(null); });
  els.cancelBtn.addEventListener("click", function () { closeEditor(true); });
  els.bannerClose.addEventListener("click", function () {
    els.banner.hidden = true;
    var fn = bannerOnClose;
    bannerOnClose = null;
    if (fn) fn();
  });
  els.editor.addEventListener("submit", submitEditor);
  els.editor.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeEditor(true); }
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (els.editor.requestSubmit) els.editor.requestSubmit(); else submitEditor(e);
    }
  });
  els.fTitle.addEventListener("input", function () { if (els.formMsg.textContent) setMsg(""); });
  els.search.addEventListener("input", function () { state.query = els.search.value; render(); });
  document.addEventListener("keydown", function (e) {
    if (els.viewer.open || els.profileDlg.open || els.calDialog.open || els.settingsDlg.open) return;
    var mod = e.ctrlKey || e.metaKey;
    // Tabs like in a browser, and the small assistant window.
    if (mod && !e.altKey && e.code === "Tab") {
      e.preventDefault();
      if (tabs.list.length > 1) activateTab((tabs.active + (e.shiftKey ? -1 : 1) + tabs.list.length) % tabs.list.length);
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.code === "KeyT") { e.preventDefault(); setTabMenu(true); return; }
    if (mod && !e.shiftKey && !e.altKey && e.code === "KeyW") { e.preventDefault(); closeTab(tabs.active); return; }
    if (mod && !e.shiftKey && !e.altKey && e.code === "KeyK") { e.preventDefault(); setQuick(els.qa.hidden); return; }
    if (mod && !e.shiftKey && !e.altKey && (e.code === "KeyN")) {
      e.preventDefault();
      setPage("prompts");
      if (!state.editorOpen) openEditor(null); else els.fTitle.focus();
    }
    else if (mod && !e.shiftKey && !e.altKey && (e.code === "KeyF")) {
      e.preventDefault();
      setPage("prompts");
      if (!els.toolbar.hidden) { els.search.focus(); els.search.select(); }
    }
    else if (e.key === "Escape" && document.activeElement === els.search && els.search.value) {
      els.search.value = ""; state.query = ""; render();
    }
  });
  var resizeTimer = null;
  window.addEventListener("resize", function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(queueMeasure, 120); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueMeasure);

  /* ---------- start ---------- */
  if (api.platform === "win32") els.titlebar.classList.add("win");
  render();
  api.onDataChanged(function (prompts) {
    setItems(prompts);
    render();
    toast("Промты обновились из папки");
  });
  call(api.load()).then(function (r) {
    state.loaded = true;
    restoreTabs(r && r.info && r.info.tabs);
    if (!r) return;
    if (state.profile && !state.profile.welcomed) openProfile(true);
    var n = r.notice;
    if (!n) return;
    if (n.kind === "created") toast("Создал папку «Snowball.ai» в Документах. Там хранятся все промты и файлы.", true);
    else if (n.kind === "renamed") toast("Папка с данными теперь называется «Snowball.ai». Все промты и файлы на месте.", true);
    else if (n.kind === "rename-later") showBanner("Промты на месте, но папку в Документах пока не получилось переименовать: она открыта в другой программе. Закройте Проводник и перезапустите программу, папка переименуется сама.");
    else if (n.kind === "restored") showBanner("Файл с промтами оказался повреждён, поэтому я открыл последнюю сохранённую копию. Повреждённый файл лежит рядом, в той же папке.");
    else if (n.kind === "reset") showBanner("Файл с промтами оказался повреждён, а резервной копии нет. Повреждённый файл лежит в той же папке с именем prompts.broken-….json.");
    else if (n.kind === "missing") showBanner("Папка " + n.dir + " недоступна, поэтому я открыл папку в Документах. Если это был съёмный диск, подключите его и выберите папку снова через меню профиля внизу слева.");
  });
})();
