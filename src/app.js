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
  var ACTIONS = ["created", "edited", "files", "copied", "calendar", "assistant", "tasks", "transcribe", "screenshots", "skills"];
  // How the statistics page groups them in "Что вы чаще всего делаете".
  var USE_GROUPS = [
    { name: "Промты: новые и правки", keys: ["created", "edited"], icon: "pencil" },
    { name: "Календарь", keys: ["calendar"], icon: "calendar" },
    { name: "Задачи", keys: ["tasks"], icon: "tasks" },
    { name: "Ассистент", keys: ["assistant"], icon: "spark" },
    { name: "Транскрибация", keys: ["transcribe"], icon: "wave" },
    { name: "Снимки экрана", keys: ["screenshots"], icon: "window" },
    { name: "Скиллы", keys: ["skills"], icon: "doc" },
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
    tasks: [],            // tasks board: { id, title, status (a column id), note, due, time, priority, tags, subtasks, doneFrom, order }
    taskColumns: [],      // all task columns in order: { id, name, base? , color? }
    taskArchiveMode: "day", // done tasks go to the archive by themselves: "day", "week" or "manual"
    skills: [],           // «Скиллы» on the «Промты» page: { id, title, type, desc, descBy, descCost, descAt, file, main, inside, files, text, createdAt }
    lib: "prompts",       // which list the «Промты» page shows: "prompts" or "skills"
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

  // «Транскрибация»: list — the history (newest first, without timings); file — the picked file before it is transcribed;
  // open — the transcription on the screen (with cues and pauses); view — "text", "cues" or "sum".
  var tr = {
    list: [], q: "", file: null, open: null, view: "text", fmt: "plain", busy: false, stop: false,
    prog: 0, progText: "", error: "", sumBusy: false, model: "gpt-transcribe", subs: null
  };
  // trModel2: the choice remembered since GPT transcribe became the main model (the old trModel was mostly mini).
  try { tr.model = localStorage.getItem("trModel2") || tr.model; tr.fmt = localStorage.getItem("trFmt") || tr.fmt; } catch (e) { /* defaults */ }

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    titlebar: $("titlebar"), scroller: $("scroller"),
    meta: $("meta"), addBtn: $("add-btn"), menuBtn: $("menu-btn"), menu: $("menu"),
    banner: $("banner"), bannerText: $("banner-text"), bannerAction: $("banner-action"), bannerAction2: $("banner-action2"), bannerClose: $("banner-close"),
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
      tasks: $("view-tasks"), stats: $("view-stats"), home: $("view-home"), transcribe: $("view-transcribe"), screenshots: $("view-screenshots")
    },
    trMain: $("tr-main"), trList: $("tr-list"), trSearch: $("tr-search"),
    sideAvatar: $("side-avatar"), sideName: $("side-name"),
    menuAvatar: $("menu-avatar"), menuName: $("menu-name"), menuSub: $("menu-sub"),
    statsAvatar: $("stats-avatar"), statsName: $("stats-name"), statsSince: $("stats-since"), statsEdit: $("stats-edit"),
    metrics: $("metrics"), topList: $("top-list"), heat: $("heat"), heatTip: $("heat-tip"), breakdown: $("breakdown"),
    updCard: $("set-update"), updBadge: $("upd-badge"), updLine: $("upd-line"), updBar: $("upd-bar"), updBarFill: $("upd-bar-fill"),
    updActions: $("upd-actions"), updNew: $("upd-new"), updNewTitle: $("upd-new-title"), updNewBody: $("upd-new-body"),
    settingsDlg: $("settings-dlg"), settingsClose: $("settings-close"), settingsMain: $("settings-main"), setBackupMsg: $("set-backup-msg"),
    updCurrent: $("upd-current"), updCurrentTitle: $("upd-current-title"), updCurrentBody: $("upd-current-body"), setNavDot: $("set-nav-dot"),
    chat: $("chat"), chatEmpty: $("chat-empty"), chatIdeas: $("chat-ideas"), chatNew: $("chat-new"),
    composer: $("composer"), chatInput: $("chat-input"), chatSend: $("chat-send"), chatAtt: $("chat-att"), chatAttach: $("chat-attach"), chatFile: $("chat-file"),
    calMeta: $("cal-meta"), calAdd: $("cal-add"), calTitle: $("cal-title"), calToday: $("cal-today"), calPrev: $("cal-prev"), calNext: $("cal-next"),
    calDialog: $("cal-dialog"), calViewBtn: $("cal-view-btn"), calViewMenu: $("cal-view-menu"), calViewName: $("cal-view-name"),
    calMonthView: $("cal-month-view"), calWeekView: $("cal-week-view"), cwHead: $("cw-head"), cwBody: $("cw-body"),
    calGrid: $("cal-grid"), calDayTitle: $("cal-day-title"), calDaySub: $("cal-day-sub"), calDayAdd: $("cal-day-add"), calDayBadge: $("cal-day-badge"),
    calForm: $("cal-form"), calFormTitle: $("cal-form-title"), cfWho: $("cf-who"), cfTitle: $("cf-title"), cfDate: $("cf-date"), cfFrom: $("cf-from"), cfTo: $("cf-to"),
    cfKind: $("cf-kind"), cfRemind: $("cf-remind"), cfNote: $("cf-note"), cfSave: $("cf-save"), cfCancel: $("cf-cancel"), cfDelete: $("cf-delete"), cfMsg: $("cf-msg"),
    calTimeline: $("cal-timeline"),
    chatMode: $("chat-mode"), chatMeta: $("chat-meta"), chatConnect: $("chat-connect"), setNotify: $("set-notify"), setConfirm: $("set-confirm"),
    setDir: $("set-dir"), setDirChange: $("set-dir-change"), setBackupSave: $("set-backup-save"), setBackupOpen: $("set-backup-open"), themeValue: $("theme-value"),
    timerRow: $("timer-row"), timerPop: $("timer-pop"),
    tabs: $("tabs"), tabPlus: $("tab-plus"), soloTitle: $("solo-title"), soloBack: $("solo-back"), tabMenu: $("tab-menu"), upList: $("up-list"), board: $("board"), tasksMeta: $("tasks-meta"),
    tbar: $("tbar"), tbarInput: $("tbar-input"), tbarModel: $("tbar-model"), tbarSend: $("tbar-send"), tnotes: $("tnotes"),
    tpanel: $("tpanel"), utoast: $("utoast"), utoastText: $("utoast-text"), utoastUndo: $("utoast-undo"),
    tview: $("tview"), tsearch: $("tsearch"), tfTag: $("tf-tag"), tfPrio: $("tf-prio"), tfDone: $("tf-done"), tfReset: $("tf-reset"), tlist: $("tlist"), boardHint: $("board-hint"),
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
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>',
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
    window: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6.5" width="13" height="13" rx="2"/><path d="M8 3.5h10.5A2 2 0 0 1 20.5 5.5V16"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9.5L15.5 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z"/><path d="M15.5 20.5V16a.5.5 0 0 1 .5-.5h4.5M7.5 9h9M7.5 12.5h6"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5-5.5-2L10 9Z"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6h-6v6H5.5A1.5 1.5 0 0 1 4 19Z"/></svg>',
    tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="16.5" y="4" width="4" height="7" rx="1.5"/></svg>',
    prompts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h7.5L19 8v12.5H7zM14 3.5V8h5M9.5 12.5h6M9.5 16h6"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-7l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 16V7A1.5 1.5 0 0 1 5 5.5Z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg>',
    archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/></svg>',
    wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3"/></svg>',
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="m10 9.5 4.5 2.5-4.5 2.5z"/></svg>',
    music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17.5V6l10-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
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
    // action.label2: a second button, for example «Как пользоваться» next to «Что нового»
    els.bannerAction2.hidden = !(action && action.label2);
    els.bannerAction2.textContent = (action && action.label2) || "";
    els.bannerAction2.onclick = (action && action.onclick2) || null;
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
    if (r.taskColumns) state.taskColumns = r.taskColumns;
    if (r.taskArchiveMode) state.taskArchiveMode = r.taskArchiveMode;
    if (r.skills) state.skills = r.skills;
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
      markTheme(state.info);
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
    renderSkills();
    restoreFocus(focus);
    if (viewerState) renderViewerIfChanged();
    renderChrome();
    if (state.page === "stats") renderStats();
    if (state.page === "calendar") renderCalendar();
    if (state.page === "tasks") renderTasks();
    if (state.page === "transcribe") renderTranscribe();
    renderTaskPanel();
  }

  /* ---------- tabs ---------- */
  // Like a browser: every section opens in a tab on top of the window. Prompts, calendar, tasks, generator and statistics
  // open once (opening again switches to that tab); LLM tabs open as many times as needed, each with its own conversation.
  // A tab: { id, kind, session? (LLM), usedAt }. The list and the open tab are kept in settings.json (set-tabs).
  var TABS = {
    home: { name: "Главная", icon: "home" },
    prompts: { name: "Промты", icon: "prompts" },
    calendar: { name: "Календарь", icon: "calendar" },
    tasks: { name: "Задачи", icon: "tasks", beta: true },
    assistant: { name: "LLM", icon: "chat", many: true },
    transcribe: { name: "Транскрибация", icon: "wave" },
    screenshots: { name: "Снимки", icon: "window" },
    generator: { name: "Генератор", icon: "spark" },
    stats: { name: "Статистика", icon: "stats" }
  };
  var TAB_ORDER = ["home", "prompts", "calendar", "tasks", "assistant", "transcribe", "screenshots", "generator", "stats"];
  var tabs = { list: [], active: -1, seq: 0 };
  // The first window is the main one: its tabs are remembered. A window opened from a moved tab gets its tabs in the address
  // (?tabs=[…]) and does not remember them; if the main window is closed, the next one becomes main ('window-main').
  var startTabs = null;
  try { startTabs = JSON.parse(new URLSearchParams(location.search).get("tabs") || "null"); } catch (e) { startTabs = null; }
  var isMainWindow = !startTabs;
  // Such a window shows only its tab: no sidebar and no tab strip ("solo"). Becoming the main window brings them back.
  if (startTabs) document.documentElement.classList.add("solo");
  function isSolo() { return document.documentElement.classList.contains("solo"); }
  api.onWindowMain(function () { isMainWindow = true; document.documentElement.classList.remove("solo"); saveTabs(); render(); });

  // The sidebar folds into a strip of icons: by the button at its top or Ctrl + B, and by itself in a window narrower than 900 px.
  // The choice for a wide window is remembered (localStorage sideMini); in a narrow one the button opens the panel
  // only until the window gets wide (or narrow) again.
  var SIDE_NARROW = window.matchMedia("(max-width: 900px)");
  var side = { el: document.querySelector(".side"), mini: false, narrowOpen: false, folded: null, sent: -1 };
  try { side.mini = localStorage.getItem("sideMini") === "1"; } catch (e) {}
  function applySide() {
    var folded = SIDE_NARROW.matches ? !side.narrowOpen : side.mini, btn = $("side-toggle");
    if (folded === side.folded) return;
    // While it slides, nothing spills out of it; while it opens, the wide layout keeps its width.
    if (side.folded !== null && !reducedMotion && !isSolo()) {
      side.el.classList.add("side-moving");
      side.el.classList.toggle("side-opening", !folded);
      clearTimeout(side.timer);
      side.timer = setTimeout(function () { side.el.classList.remove("side-moving", "side-opening"); }, 260);
    }
    side.folded = folded;
    document.documentElement.classList.toggle("side-mini", folded);
    var label = folded ? "Развернуть панель" : "Свернуть панель";
    btn.title = label + " (Ctrl + B)";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-expanded", String(!folded));
  }
  function toggleSide() {
    if (SIDE_NARROW.matches) side.narrowOpen = !side.narrowOpen;
    else {
      side.mini = !side.mini;
      try { localStorage.setItem("sideMini", side.mini ? "1" : "0"); } catch (e) {}
    }
    applySide();
  }
  SIDE_NARROW.addEventListener("change", function () { side.narrowOpen = false; applySide(); });
  $("side-toggle").addEventListener("click", toggleSide);
  // main.js has to know where the tab strip begins, to catch a separate window dropped back on it.
  function reportSideWidth() {
    if (!isMainWindow || isSolo()) return;
    var w = Math.round(side.el.getBoundingClientRect().right);
    if (w !== side.sent) { side.sent = w; api.sideWidth(w); }
  }
  if (window.ResizeObserver) new ResizeObserver(reportSideWidth).observe(side.el);
  applySide();
  function activeTab() { return tabs.list[tabs.active] || null; }
  function chatTitle(id) { var c = hist.list.find(function (x) { return x.id === id; }); return c ? c.title : ""; }
  function tabTitle(t) {
    if (t.kind === "transcribe") return TABS.transcribe.name + (tr.open ? " · " + stemOf(tr.open.name) : tr.file ? " · " + stemOf(tr.file.name) : "");
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
    if (t.kind === "assistant") { growInput(); scrollChat(); els.chatInput.focus({ preventScroll: true }); }
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
    if (!isMainWindow) return;
    api.setTabs({
      list: tabs.list.map(tabDesc),
      active: tabs.active
    });
  }
  // The tabs saved last time; an LLM tab loads its conversation when it is first opened.
  function restoreTabs(saved) {
    if (startTabs) saved = { list: startTabs, active: 0 };
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
    var cur = activeTab();
    document.title = cur ? tabTitle(cur) + " — Snowball.ai" : "Snowball.ai";
    if (isSolo()) {
      els.soloTitle.replaceChildren(h("img", { src: "../assets/icon.png", alt: "" }),
        cur ? h("span", { class: "tab-ico", html: ICONS[TABS[cur.kind].icon], "aria-hidden": "true" }) : null, h("span", { text: cur ? tabTitle(cur) : "Snowball.ai" }));
    }
    els.tabs.replaceChildren.apply(els.tabs, tabs.list.map(function (t, i) {
      var title = tabTitle(t), on = i === tabs.active;
      return h("div", { class: "tab" + (on ? " on" : ""), role: "tab", "aria-selected": String(on), tabindex: on ? "0" : "-1", title: title,
        draggable: "true", "data-i": String(i),
        onclick: function () { activateTab(i); },
        onauxclick: function (e) { if (e.button === 1) { e.preventDefault(); closeTab(i); } },
        oncontextmenu: function (e) { e.preventDefault(); openTabCtx(i, e.clientX, e.clientY); },
        ondragstart: function (e) { tabDrag.from = i; tabDrag.dropped = false; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/x-snowball-tab", String(i)); },
        ondragover: function (e) { if (tabDrag.from === null) return; e.preventDefault(); markTabDrop(this, e); },
        ondragleave: function () { this.classList.remove("drop-before", "drop-after"); },
        ondrop: function (e) { if (tabDrag.from === null) return; e.preventDefault(); dropTab(i, e); },
        ondragend: function (e) { endTabDrag(e); },
        onkeydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activateTab(i); } } },
        h("span", { class: "tab-ico", html: ICONS[TABS[t.kind].icon], "aria-hidden": "true" }),
        h("span", { class: "tab-t", text: title }),
        t.session && t.session.current ? h("span", { class: "tab-busy", title: "Пишет ответ" }) :
          t.kind === "transcribe" && tr.busy ? h("span", { class: "tab-busy", title: "Идёт расшифровка" }) :
          t.session && t.session.unread ? h("span", { class: "tab-unread", title: "Есть новый ответ" }) : null,
        h("button", { type: "button", class: "tab-x", title: "Закрыть вкладку (Ctrl + W)", "aria-label": "Закрыть вкладку «" + title + "»", html: ICONS.x,
          onclick: function (e) { e.stopPropagation(); closeTab(i); } }));
    }));
  }
  // Dragging a tab: dropped on another tab it goes before or after it (by the half it was dropped on);
  // dropped outside the window it opens in a window of its own right there.
  var tabDrag = { from: null, dropped: false };
  function markTabDrop(el, e) {
    var r = el.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
    el.classList.toggle("drop-before", !after);
    el.classList.toggle("drop-after", after);
  }
  function dropTab(i, e) {
    var from = tabDrag.from;
    tabDrag.dropped = true;
    var el = els.tabs.children[i], r = el.getBoundingClientRect();
    var to = e.clientX > r.left + r.width / 2 ? i + 1 : i;
    if (from < to) to--;
    if (to === from) { renderTabs(); return; }
    var activeT = activeTab(), t = tabs.list.splice(from, 1)[0];
    tabs.list.splice(to, 0, t);
    tabs.active = tabs.list.indexOf(activeT);
    renderTabs();
    saveTabs();
  }
  function endTabDrag(e) {
    var from = tabDrag.from;
    tabDrag.from = null;
    tabGhost.hidden = true;
    els.tabs.querySelectorAll(".drop-before, .drop-after").forEach(function (el) { el.classList.remove("drop-before", "drop-after"); });
    if (tabDrag.dropped || from === null) return;
    var outside = e.screenX < window.screenX || e.screenX > window.screenX + window.outerWidth || e.screenY < window.screenY || e.screenY > window.screenY + window.outerHeight;
    if (outside && (e.screenX || e.screenY)) tabToWindow(from, "point", { x: e.screenX, y: e.screenY });
  }
  // Pulled down off the tab strip, a tab can be let go anywhere in the window, on any monitor: a frame of the future
  // window follows the mouse («Отпустите — откроется в отдельном окне»), and the window opens where it was let go.
  // Let go on the strip again, nothing happens.
  var tabGhost = h("div", { class: "tab-ghost", hidden: true, "aria-hidden": "true" },
    h("div", { class: "tab-ghost-bar" }, h("span", { class: "tab-ghost-ico" }), h("span", { class: "tab-ghost-t" })),
    h("div", { class: "tab-ghost-hint", text: "Отпустите — откроется в отдельном окне" }));
  document.body.append(tabGhost);
  function offTabStrip(e) { return e.clientY > els.titlebar.getBoundingClientRect().bottom + 4; }
  document.addEventListener("dragover", function (e) {
    if (tabDrag.from === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    var off = offTabStrip(e), t = tabs.list[tabDrag.from];
    tabGhost.hidden = !off || !t;
    if (!off || !t) return;
    tabGhost.querySelector(".tab-ghost-ico").innerHTML = ICONS[TABS[t.kind].icon];
    tabGhost.querySelector(".tab-ghost-t").textContent = tabTitle(t);
    tabGhost.style.left = Math.max(4, Math.min(window.innerWidth - 264, e.clientX - 60)) + "px";
    tabGhost.style.top = Math.max(4, Math.min(window.innerHeight - 170, e.clientY - 14)) + "px";
  });
  document.addEventListener("drop", function (e) {
    if (tabDrag.from === null || e.target.closest && e.target.closest(".tab")) return;
    e.preventDefault();
    var from = tabDrag.from;
    tabDrag.dropped = true;
    tabGhost.hidden = true;
    if (offTabStrip(e)) tabToWindow(from, "point", { x: e.screenX, y: e.screenY });
  });
  // What is needed to open a tab in another window: its kind and, for LLM, the conversation.
  function tabDesc(t) { return t.kind === "assistant" ? { kind: t.kind, chatId: t.session.id || t.session.loadId || undefined } : { kind: t.kind }; }
  // Moves a tab into a new window. An LLM conversation goes with it (it is saved, the new window loads it);
  // a tab whose answer is still being written waits. The last tab leaves "Главная" behind.
  function tabToWindow(i, mode, point) {
    var t = tabs.list[i];
    if (!t) return;
    if (t.session && t.session.current) { toast("Дождитесь, пока ассистент допишет ответ, и попробуйте ещё раз."); return; }
    if (t.kind === "transcribe" && tr.busy) { toast("Дождитесь, пока закончится расшифровка, и попробуйте ещё раз."); return; }
    call(api.windowOpen([tabDesc(t)], mode, point)).then(function (r) { if (r) closeTab(tabs.list.indexOf(t)); });
  }

  /* Bringing a separate window's tab back. While that window is dragged by its title bar over this window's tab strip,
     main.js sends where the mouse is; a slot shows where the tab will go. Let go there (or press «Вернуть в основное окно»
     in the separate window), and the tab comes back right there and opens. */
  var tabSlot = h("div", { class: "tab-slot", "aria-hidden": "true" }, icon("window"), h("span", { text: "Отпустите — вкладка вернётся сюда" }));
  // The place on the strip for a point x (page pixels): before the first tab whose middle is to the right of it.
  function tabIndexAt(x) {
    if (x === null || x === undefined) return tabs.list.length;
    var kids = Array.prototype.filter.call(els.tabs.children, function (el) { return el.classList.contains("tab"); });
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return kids.length;
  }
  api.onTabHover(function (at) {
    els.titlebar.classList.toggle("catching", !!at);
    if (!at) { tabSlot.remove(); return; }
    var kids = Array.prototype.filter.call(els.tabs.children, function (el) { return el.classList.contains("tab"); });
    tabSlot.remove();
    var i = tabIndexAt(at.x);
    if (kids[i]) els.tabs.insertBefore(tabSlot, kids[i]); else els.tabs.append(tabSlot);
  });
  api.onTabInsert(function (d) {
    els.titlebar.classList.remove("catching");
    tabSlot.remove();
    var x = d && d.tab;
    if (!x || !TABS[x.kind]) return;
    // Already open here (a section or the same conversation): just switch to it.
    var have = tabs.list.findIndex(function (t) {
      return t.kind === x.kind && (!TABS[x.kind].many || x.chatId && t.session && (t.session.id === x.chatId || t.session.loadId === x.chatId));
    });
    if (have !== -1) { activateTab(have); return; }
    var t = makeTab(x.kind);
    if (t.session && x.chatId) t.session.loadId = x.chatId;
    var at = tabIndexAt(d.x);
    tabs.list.splice(at, 0, t);
    activateTab(at);
  });
  // In a separate window: hand its tab back to the main window.
  function returnToMain(x) {
    var t = activeTab();
    if (!t || isMainWindow) return;
    if (t.session && t.session.current) { toast("Дождитесь, пока ассистент допишет ответ, и попробуйте ещё раз."); return; }
    if (t.kind === "transcribe" && tr.busy) { toast("Дождитесь, пока закончится расшифровка, и попробуйте ещё раз."); return; }
    if (t.session) persist(t.session);
    call(api.windowReturn(tabDesc(t), x));
  }
  api.onReturnTab(function (at) { returnToMain(at ? at.x : null); });
  els.soloBack.addEventListener("click", function () { returnToMain(null); });
  // Right click on a tab.
  var ctxMenu = h("div", { class: "menu tab-ctx", role: "menu", hidden: true });
  document.body.append(ctxMenu);
  function openTabCtx(i, x, y) {
    setTabMenu(false);
    var item = function (label, ic, fn) {
      return h("button", { type: "button", role: "menuitem", onclick: function () { ctxMenu.hidden = true; fn(); } },
        h("span", { class: "ico", html: ic, "aria-hidden": "true" }), h("span", { text: label }));
    };
    ctxMenu.replaceChildren.apply(ctxMenu, [
      item("Открыть в новом окне", ICONS.window, function () { tabToWindow(i, null); }),
      h("hr"),
      item("Закрыть вкладку", ICONS.x, function () { closeTab(i); }),
      tabs.list.length > 1 ? item("Закрыть другие вкладки", ICONS.x, function () {
        var keep = tabs.list[i];
        tabs.list.slice().forEach(function (t) { if (t !== keep) closeTab(tabs.list.indexOf(t)); });
      }) : null].filter(Boolean));
    ctxMenu.hidden = false;
    ctxMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - ctxMenu.offsetWidth - 8)) + "px";
    ctxMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - ctxMenu.offsetHeight - 8)) + "px";
    var first = ctxMenu.querySelector("button");
    if (first) first.focus();
  }
  ctxMenu.addEventListener("keydown", function (e) {
    var items = Array.prototype.slice.call(ctxMenu.querySelectorAll("button"));
    var k = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); ctxMenu.hidden = true; }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(k + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus(); }
  });
  document.addEventListener("mousedown", function (e) { if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) ctxMenu.hidden = true; });
  window.addEventListener("blur", function () { ctxMenu.hidden = true; });

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
        isOpen ? h("small", { text: "уже открыта" }) : TABS[k].beta ? h("small", null, h("span", { class: "alpha", text: "Бета" })) : null);
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
    renderCaptureKey();
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
    if (state.page === "screenshots" && window.SnowCapture && !window.screenshotEditor) window.screenshotEditor = window.SnowCapture.mount($("screenshots-root"), api);
  }

  // The small counters on the section icons: what is left for today, tasks not done yet, answers not read yet.
  function renderCaptureKey() {
    var button = document.querySelector('.capture-nav'), key = window.SnowShortcut.format(state.info && state.info.captureShortcut);
    var broken = (state.info && state.info.captureNotice) || '';
    if (button) {
      button.querySelector('kbd').textContent = key;
      button.title = 'Снимки экрана · ' + key + (broken ? '\n' + broken : '');
      button.classList.toggle('warn', !!broken);
    }
    var label = $('capture-settings-key');
    if (label) label.textContent = key;
    var notice = $('capture-shortcut-notice');
    if (notice) { notice.hidden = !(state.info && state.info.captureNotice); notice.querySelector('span').textContent = (state.info && state.info.captureNotice) || ''; }
  }
  window.SnowShortcut.mount($('capture-settings-control'), api);
  api.onCaptureChanged(function (value) { if (value && state.info) { state.info.captureShortcut = value.shortcut; state.info.captureNotice = value.shortcutNotice; } renderCaptureKey(); if (state.page === 'home') renderHome(); });
  function badgeCounts() {
    var now = new Date(), today = dayKey(now), mins = now.getHours() * 60 + now.getMinutes();
    return {
      calendar: (state.events || []).filter(function (e) { return e.date === today && (e.to ? minutesOf(e.to) : minutesOf(e.from) + 30) > mins; }).length,
      tasks: (state.tasks || []).filter(function (t) { return t.status !== "done"; }).length,
      assistant: sessions.filter(function (se) { return se.unread; }).length,
      transcribe: tr.busy ? 1 : 0,
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
      { page: "transcribe", title: "Транскрибация", text: tr.busy ? "Идёт расшифровка…" : tr.list.length ? tr.list.length + " " + plural(tr.list.length, "расшифровка", "расшифровки", "расшифровок") + " в истории" : "Текст и субтитры из аудио и видео" },
      { page: "screenshots", title: "Снимки", text: window.SnowShortcut.format(state.info && state.info.captureShortcut) + " · Захват экрана, пометки и история" },
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
        title: (on ? "Идёт сейчас: " : "") + timeRange(e) + " " + evName(e) + (e.note ? " — " + e.note : ""), onclick: function () { openCalendarDay(e.date); } },
        h("i", { "aria-hidden": "true" }), h("span", { class: "tt", text: evName(e) }), h("span", { class: "tm", text: on ? "сейчас" : e.from })));
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
      var pct = Math.round(r.n / total * 100), label = r.n && !pct ? "<1%" : pct + "%";
      // A narrow bar has no room for its number: then it stands right after the bar.
      var inside = pct >= 12;
      return h("div", { class: "top-row" + (r.n ? "" : " zero") },
        h("span", { class: "top-ico", html: ICONS[r.g.icon], "aria-hidden": "true" }),
        h("span", { class: "top-bar" }, fillBar(r.n ? Math.max(pct, 3) : 0, inside ? label : ""), inside ? null : h("span", { class: "top-pct", text: label })),
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
    // Under the graph: what was done today (the day that is still going) and over the year.
    var chip = function (label, n) { return h("span", { class: "bchip" }, label + " ", h("b", { text: fmtNum(n) })); };
    var CHIPS = [["Создано промтов", "created"], ["Правок", "edited"], ["Прикреплено файлов", "files"], ["Скопировано", "copied"],
      ["Дел в календаре", "calendar"], ["Действий с задачами", "tasks"], ["Сообщений ассистенту", "assistant"], ["В транскрибации", "transcribe"], ["Снимков", "screenshots"]];
    var todayDay = ((state.activity && state.activity.days) || {})[dayKey(today())] || {};
    var todayChips = CHIPS.filter(function (c) { return todayDay[c[1]]; }).map(function (c) { return chip(c[0], todayDay[c[1]]); });
    var group = function (name, kids) { return h("div", { class: "bd-group" }, h("span", { class: "bd-label", text: name }), h("div", { class: "breakdown" }, kids)); };
    els.breakdown.replaceChildren(
      group("Сегодня, " + fmtDay(today(), true), todayChips.length ? todayChips : [h("span", { class: "muted", text: "Пока без действий" })]),
      group("За год", CHIPS.filter(function (c) { return c[1] !== "screenshots" || s.by.screenshots; }).map(function (c) { return chip(c[0], s.by[c[1]]); })));
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
  // Inside "Тема" the "macOS ›" item opens a third list (accent and light/dark); opening it keeps "Тема" open.
  function subWrap(name) { var b = name && els.menu.querySelector(".has-sub[data-sub=\"" + name + "\"]"); return b ? b.closest(".sub-wrap") : null; }
  function parentSub(w) { var p = w && w.parentElement.closest(".sub-wrap"); return p ? p.querySelector(".has-sub").dataset.sub : null; }
  function openSub(name, focusFirst) {
    var target = subWrap(name);
    els.menu.querySelectorAll(".sub-wrap").forEach(function (w) {
      var btn = w.querySelector(".has-sub"), on = !!target && w.contains(target), was = w.classList.contains("open");
      w.classList.toggle("open", on);
      btn.setAttribute("aria-expanded", String(on));
      if (on && !was) fitSubmenu(w.querySelector(".submenu"));
    });
    if (target && focusFirst) {
      var list = target.querySelector(".submenu");
      var f = list.querySelector(":scope > button[aria-checked=\"true\"], :scope > .sub-wrap > .has-sub[aria-checked=\"true\"], :scope > [role=\"group\"] > button[aria-checked=\"true\"]") || list.querySelector("button");
      if (f) f.focus();
    }
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
  // The deepest open list (the third one when "macOS ›" is open).
  function openSubWrap() { var all = els.menu.querySelectorAll(".sub-wrap.open"); return all.length ? all[all.length - 1] : null; }
  els.menu.querySelectorAll(".sub-wrap").forEach(function (w) {
    var name = w.querySelector(".has-sub").dataset.sub;
    w.addEventListener("mouseenter", function () {
      var open = openSubWrap();
      // A list inside the open one (or the open one itself) opens at once; a list elsewhere waits a moment.
      if (!open || open === w || open.contains(w)) { clearTimeout(subTimer); openSub(name); }
      else subLater(function () { openSub(name); }, 260);
    });
    // Leaving a list goes back to the list it sits in (or closes all for a top one).
    w.addEventListener("mouseleave", function () { subLater(function () { if (!w.contains(document.activeElement)) openSub(parentSub(w)); }, 350); });
    w.querySelector(".has-sub").addEventListener("click", function () { clearTimeout(subTimer); openSub(name, true); });
  });
  // Plain items of a list close the lists opened from it.
  [els.menu].concat(Array.prototype.slice.call(els.menu.querySelectorAll(".submenu"))).forEach(function (list) {
    var own = list === els.menu ? null : list.closest(".sub-wrap").querySelector(".has-sub").dataset.sub;
    list.querySelectorAll(":scope > button, :scope > hr, :scope > p, :scope > [role=\"group\"]").forEach(function (b) {
      b.addEventListener("mouseenter", function () { subLater(function () { openSub(own); }, 260); });
    });
  });
  els.menuBtn.addEventListener("click", function () { setMenu(els.menu.hidden); });
  document.addEventListener("mousedown", function (e) {
    if (!els.menu.hidden && !els.menu.contains(e.target) && !els.menuBtn.contains(e.target)) setMenu(false);
  });
  els.menu.addEventListener("keydown", function (e) {
    var sub = document.activeElement && document.activeElement.closest(".submenu");
    var scope = sub || els.menu;
    var items = Array.prototype.slice.call(scope.querySelectorAll(":scope > button, :scope > .sub-wrap > .has-sub, :scope > [role=\"group\"] > button"));
    var i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); setMenu(false); els.menuBtn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === "ArrowRight" && document.activeElement.classList.contains("has-sub")) { e.preventDefault(); openSub(document.activeElement.dataset.sub, true); }
    else if (e.key === "ArrowLeft" && sub) { e.preventDefault(); var w = sub.closest(".sub-wrap"); openSub(parentSub(w)); w.querySelector(".has-sub").focus(); }
  });
  var THEME_NAMES = { system: "Как в Windows", light: "Светлая", dark: "Тёмная", white: "Белая", black: "Чёрная", macos: "macOS" };
  // info: theme, and for "macos" its accent colour (macAccent), light/dark (macLook) and whether the window is glass.
  function markTheme(info) {
    var t = (info && info.theme) || "system", root = document.documentElement;
    els.menu.querySelectorAll("button[data-theme]").forEach(function (b) {
      b.setAttribute("aria-checked", String(b.dataset.theme === t));
    });
    els.menu.querySelectorAll("button[data-accent]").forEach(function (b) {
      b.setAttribute("aria-checked", String(t === "macos" && b.dataset.accent === info.macAccent));
    });
    els.menu.querySelectorAll("button[data-look]").forEach(function (b) {
      b.setAttribute("aria-checked", String(b.dataset.look === ((info && info.macLook) || "system")));
    });
    els.themeValue.textContent = THEME_NAMES[t] || "";
    // "Белая" and "Чёрная" are colour sets on top of the light and dark ones (styles.css, :root[data-theme]);
    // "macOS" changes surfaces, shapes and the accent (theme-macos.css); with glass the desktop shows through the window.
    if (t === "white" || t === "black" || t === "macos") root.dataset.theme = t;
    else delete root.dataset.theme;
    if (t === "macos") root.dataset.accent = info.macAccent || "peach";
    else delete root.dataset.accent;
    root.classList.toggle("glass", !!(info && info.glass));
  }
  // Theme items keep the menu open, so the change can be seen right away.
  els.menu.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-theme], button[data-accent], button[data-look]");
    if (!b) return;
    var req = b.dataset.theme ? api.setTheme(b.dataset.theme)
      : api.setMacStyle(b.dataset.accent ? { accent: b.dataset.accent } : { look: b.dataset.look });
    call(req).then(function (r) { if (r) markTheme(r.info); });
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
      backupMessage("Резервная копия сохранена: " + r.path + ". В ней промтов " + c.prompts + ", файлов " + c.files + ", разговоров " + c.chats + ", дел в календаре " + c.events + (c.transcripts ? ", расшифровок " + c.transcripts : "") + ". Ключей ChatGPT и Claude в ней нет.");
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
      refreshTranscripts();
      render();
      var parts = [];
      if (x.prompts) parts.push("промтов " + x.prompts);
      if (x.chats) parts.push("разговоров " + x.chats);
      if (x.events) parts.push("дел в календаре " + x.events);
      if (x.transcripts) parts.push("расшифровок " + x.transcripts);
      if (x.screenshots) parts.push("снимков " + x.screenshots);
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
  // The full installer (size) is big, but the program downloads only what changed since your version (total in progress),
  // usually much less. So before the download it says so, and after it — how much really came down.
  function sizeNote() { return upd.size ? " Полная версия весит " + fmtMB(upd.size) + ", но скачается только то, что изменилось, — обычно намного меньше." : ""; }
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
      line = "Вышла новая версия " + v + ". Сейчас у вас " + upd.current + "." + sizeNote() + " Установится она после перезапуска.";
      actions.push(updButton("Скачать обновление", true, startDownload));
    } else if (s === "progress") {
      var total = upd.total || upd.size;
      line = "Скачиваю версию " + v + ": " + (total ? fmtMB(upd.transferred) + " из " + fmtMB(total) + ", " : "") + upd.percent + "%. Можно закрыть настройки и продолжать работать, программа сообщит, когда всё будет готово.";
    } else if (s === "download-error") {
      line = "Не получилось скачать версию " + v + ". Проверьте интернет и попробуйте ещё раз.";
      actions.push(updButton("Попробовать ещё раз", true, startDownload));
    } else if (s === "ready") {
      line = "Версия " + v + " готова к установке" + (upd.total ? " (скачано " + fmtMB(upd.total) + ")" : "") + ". Перезапустите программу, чтобы её установить. Если не сейчас, она установится сама, когда вы закроете программу.";
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
    els.updBadge.textContent = found ? "Есть новая версия" : upd.current ? "Версия " + upd.current : "";
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
    renderGuidesPage();
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
        showBanner("Вышла новая версия Snowball.ai " + u.version + ". Посмотрите, что в ней нового, и скачайте её в «Настройках».", {
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
      var g = guideByVersion(r.whatsNew, r.whatsNewFrom), gNew = g && guideFresh(g.version, r.whatsNew, r.whatsNewFrom);
      showBanner("Snowball.ai обновлена до версии " + r.whatsNew + "." + (!g ? " Посмотрите, что нового и как этим пользоваться."
        : gNew ? (g.news ? " Новое: " + g.news + ". Посмотрите по картинкам, как этим пользоваться." : " Новое: раздел «" + g.title + "». Посмотрите по картинкам, как им пользоваться.")
        : g.news ? " Обновлено: " + g.title + ". Посмотрите по картинкам, что изменилось."
        : " В разделе «" + g.title + "» много нового. Посмотрите по картинкам, что изменилось."), {
        label: g ? "Как пользоваться" : "Что нового", close: "Понятно",
        onclick: function () { els.banner.hidden = true; if (g) openGuide(g); else openUpdates(true); },
        label2: g ? "Что нового" : null, onclick2: function () { els.banner.hidden = true; openUpdates(true); }
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
  // How an event is called everywhere: «С кем: тема», or just the topic when nobody is named.
  function evName(e) { return e.who ? e.who + ": " + e.title : e.title; }
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
        list.slice(0, shown).map(function (e) { return h("span", { class: "ev ev-" + kindOfEvent(e).id }, h("i"), e.recap ? h("span", { class: "flag", html: ICONS.doc }) : null, e.from + " " + evName(e)); }),
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
      h("span", { class: "row1" }, e.recap ? h("span", { class: "flag", html: ICONS.doc, title: "Есть итоги созвона" }) : null, h("span", { class: "tm", text: timeRange(e) }), h("span", { class: "ttl", text: evName(e) }), h("span", { class: "kind", text: k.label })),
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
        b.title = timeRange(pl.e) + " " + evName(pl.e) + (pl.e.note ? " — " + pl.e.note : "");
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
    if (typeof renderCbar === "function" && cbar) renderCbar();
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
    els.cfWho.value = e ? e.who || "" : "";
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
    recapUi.q = "";
    recapUi.picked = {};
    showCalTab("ev");
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
    if (!title) { els.cfMsg.textContent = "Напишите тему дела."; els.cfTitle.focus(); return; }
    if (!els.cfDate.value) { els.cfMsg.textContent = "Выберите день."; els.cfDate.focus(); return; }
    if (to && to <= from) { els.cfMsg.textContent = "Окончание должно быть позже начала."; els.cfTo.querySelector("select").focus(); return; }
    var checked = els.cfKind.querySelector("input:checked");
    var isNew = !cal.editing;
    var ev = { id: cal.editing || undefined, date: els.cfDate.value, from: from, to: to, who: els.cfWho.value.trim(), title: title,
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
  // Close on a click outside only if it also started outside: dragging the note's resize handle and letting go
  // over the dark area is not a click outside.
  var calDownOnBackdrop = false;
  els.calDialog.addEventListener("mousedown", function (e) { calDownOnBackdrop = e.target === els.calDialog; });
  els.calDialog.addEventListener("click", function (e) { if (e.target === els.calDialog && calDownOnBackdrop) closeEventForm(); });
  els.calDialog.addEventListener("close", function () { cal.editing = null; cal.confirmDelete = false; });
  els.calAdd.addEventListener("click", function () { openEventForm(null); });
  els.calDayAdd.addEventListener("click", function () { openEventForm(null); });
  els.calPrev.addEventListener("click", function () { stepCalendar(-1); });
  els.calNext.addEventListener("click", function () { stepCalendar(1); });
  els.calToday.addEventListener("click", function () { ensureCal(); selectDay(dayKey(today())); });
  /* ---------- call summaries in the event window ----------
     A saved event has two buttons on top: «Дело» (the usual form, opens first) and «Итоги». «Итоги» holds everything about the
     call: with no summary yet a box to paste the text or choose a file; with one — short text, decisions, next steps that can
     go to the board «Задачи», meetings agreed on that can go to the calendar, and the loaded text with search.
     The summary is made in main.js (recap-make); the button beside the calendar assistant loads one for any event or a new one. */
  var calTabs = $("cal-tabs"), calRecap = $("cal-recap"), calTabTr = $("cal-tab-tr");
  var recapUi = { tab: "ev", picked: {}, q: "", text: {}, draft: {}, fname: {}, confirmRemove: false, busy: false };
  function eventById(id) { return state.events.find(function (x) { return x.id === id; }) || null; }
  function recapCopy(r) { var c = JSON.parse(JSON.stringify(r)); c.text = ""; return c; }
  function stepAdded(s) { return !!s.added && state.tasks.some(function (t) { return t.id === s.added; }); }
  function meetAdded(m) { return !!m.added && state.events.some(function (x) { return x.id === m.added; }); }
  function showCalTab(tab) {
    var e = cal.editing ? eventById(cal.editing) : null, r = e && e.recap;
    if (!e) tab = "ev";
    if (tab === "tr" && !r) tab = "sum";
    recapUi.tab = tab;
    recapUi.confirmRemove = false;
    calTabs.hidden = !e;
    calTabTr.hidden = !r;
    calTabs.querySelectorAll("[data-tab]").forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === tab)); });
    els.calForm.hidden = tab !== "ev";
    calRecap.hidden = tab === "ev";
    els.calDialog.classList.toggle("wide", tab !== "ev");
    if (tab !== "ev") { if (r) renderRecap(e); else renderRecapEmpty(e); }
  }
  // After the data changed: draw the open summary again (or close the window if the event is gone).
  function refreshRecap() {
    if (!els.calDialog.open || !cal.editing) return;
    if (!eventById(cal.editing)) { closeEventForm(); return; }
    showCalTab(recapUi.tab);
  }
  calTabs.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-tab]");
    if (b) showCalTab(b.dataset.tab);
  });
  function recapPlain(e) {
    var r = e.recap, out = ["Итоги созвона «" + evName(e) + "», " + longDay(e.date), ""];
    if (r.brief) out.push(r.brief, "");
    if (r.decisions.length) out.push("Решили:", r.decisions.map(function (d) { return "— " + d; }).join("\n"), "");
    if (r.steps.length) out.push("Следующие шаги:", r.steps.map(function (s) { return "— " + s.t + (s.who || s.due ? " (" + [s.who, s.due ? "до " + longDay(s.due) : ""].filter(Boolean).join(", ") + ")" : ""); }).join("\n"), "");
    if (r.meets.length) out.push("Договорились созвониться:", r.meets.map(function (m) { return "— " + m.t + (m.date ? ", " + longDay(m.date) + (m.from ? " в " + m.from : "") : ""); }).join("\n"), "");
    return out.join("\n").trim();
  }
  function recapToLlm(e) {
    api.recapText(e.id).then(function (r) {
      openTab("assistant", { fresh: true });
      var cur = activeTab();
      if (!cur || !cur.session) return;
      var text = "Вот итоги созвона «" + evName(e) + "» (" + longDay(e.date) + "):\n\n" + recapPlain(e) + (r && r.text ? "\n\nИ текст, из которого они сделаны:\n\n" + r.text : "") + "\n\n";
      cur.session.draft = text;
      els.chatInput.value = text;
      growInput();
      els.chatInput.focus();
      els.chatInput.setSelectionRange(text.length, text.length);
      closeEventForm();
    });
  }
  function renderRecap(e) {
    var r = e.recap, k = kindOfEvent(e);
    var head = h("div", { class: "rc-head" }, h("div", null, h("h2", { text: evName(e) }), h("p", { text: longDay(e.date) + ", " + timeRange(e) + " · " + k.label })));
    var body = recapUi.tab === "tr" ? recapTextPane(e) : recapSumPane(e);
    var foot = h("div", { class: "rc-foot" },
      h("button", { type: "button", class: "btn btn-ghost btn-sm", html: ICONS.chat, onclick: function () { recapToLlm(e); } }, "Спросить про созвон в LLM"),
      h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: function () { api.copyText(recapPlain(e)).then(function (x) { if (x && x.ok) toast("Итоги скопированы"); }); } }, "Скопировать итоги"),
      r.hasText ? h("button", { type: "button", class: "btn btn-ghost btn-sm", disabled: recapUi.busy, onclick: function () {
        recapUi.busy = true; renderRecap(e);
        api.recapRemake(e.id).then(function (x) {
          recapUi.busy = false;
          if (!x || !x.ok) { toast((x && x.error) || "Не получилось. Попробуйте ещё раз.", true); refreshRecap(); return; }
          applyData(x); renderCalendar(); refreshRecap(); toast("Итоги написаны заново" + (x.cost > 0 ? " · " + fmtCost(x.cost) : ""));
        }, function () { recapUi.busy = false; toast("Не получилось. Попробуйте ещё раз.", true); refreshRecap(); });
      } }, recapUi.busy ? "Пересоздаю…" : "Пересоздать итоги") : null,
      h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: function () {
        if (!recapUi.confirmRemove) { recapUi.confirmRemove = true; renderRecap(e); return; }
        call(api.recapUpdate(e.id, null)).then(function (x) { if (!x) return; recapUi.text[e.id] = undefined; renderCalendar(); showCalTab("sum"); toast("Итоги убраны из дела"); });
      } }, recapUi.confirmRemove ? "Точно убрать? Нажмите ещё раз" : "Убрать итоги"),
      h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: closeEventForm }, "Закрыть"));
    calRecap.replaceChildren(head, body, foot);
  }
  function recapSumPane(e) {
    var r = e.recap;
    r.steps.forEach(function (s) { if (!(s.id in recapUi.picked)) recapUi.picked[s.id] = !!s.mine && !stepAdded(s); });
    var pickedN = r.steps.filter(function (s) { return recapUi.picked[s.id] && !stepAdded(s); }).length;
    var allAdded = r.steps.length && r.steps.every(stepAdded);
    var src = h("div", { class: "rc-src" }, h("span", { class: "pill", text: r.source || "Вставленный текст" }),
      r.cost > 0 ? h("span", { text: "разобрано за " + fmtCost(r.cost) }) : null);
    var kids = [src,
      h("div", { class: "rc-blk" }, h("h5", { text: "Кратко" }), r.brief ? h("p", { text: r.brief }) : h("p", { class: "rc-empty", text: "Главного в тексте не нашлось." })),
      h("div", { class: "rc-blk" }, h("h5", { text: "Решили" }),
        r.decisions.length ? h("ul", null, r.decisions.map(function (d) { return h("li", { text: d }); })) : h("p", { class: "rc-empty", text: "Решений не названо." }))];
    kids.push(h("div", { class: "rc-blk" }, h("h5", { text: "Следующие шаги" }),
      r.steps.length ? h("div", { class: "rc-steps" }, r.steps.map(function (s) {
        var done = stepAdded(s);
        // Somebody else's step is only for information: no checkbox, it cannot go to the board (unless the user takes it).
        if (!s.mine && !done) {
          return h("div", { class: "rc-step other" }, h("span", { class: "dash", text: "—" }),
            h("span", { class: "t" }, s.t, h("span", { class: "who", text: s.who ? "делает " + s.who : "делает кто-то другой" })),
            h("button", { type: "button", class: "link-btn", title: "Если этот шаг на самом деле ваш", onclick: function () {
              recapSave(e.id, function (rc) { rc.steps.forEach(function (x) { if (x.id === s.id) x.mine = true; }); }).then(function () { delete recapUi.picked[s.id]; refreshRecap(); });
            } }, "Это мой шаг"));
        }
        return h("label", { class: "rc-step" + (done ? " added" : "") },
          h("input", { type: "checkbox", checked: recapUi.picked[s.id] || done, disabled: done, onchange: function () { recapUi.picked[s.id] = this.checked; renderRecap(e); } }),
          h("span", { class: "t" }, s.t, h("span", { class: "who", text: [s.who || "", s.due ? "до " + longDay(s.due) : "", done ? "уже на доске" : ""].filter(Boolean).join(" · ") })));
      })) : h("p", { class: "rc-empty", text: "Следующих шагов не названо." }),
      r.steps.length ? h("div", { class: "rc-act" },
        allAdded ? h("span", { class: "rc-ok", text: "✓ Все шаги на доске «Задачи»" }) :
          h("button", { type: "button", class: "btn btn-primary btn-sm", disabled: !pickedN, onclick: function () { recapAddTasks(e); } }, pickedN ? "Добавить на доску: " + pickedN : "Отметьте шаги галочкой"),
        h("span", { class: "rc-empty", text: r.steps.some(function (s) { return !s.mine && !stepAdded(s); }) ? "На доску идут только ваши шаги, шаги других людей показаны для справки. Задачи сами не появляются." : "Задачи сами не появляются." })) : null));
    if (r.meets.length) kids.push(h("div", { class: "rc-blk" }, h("h5", { text: "Договорились созвониться" }),
      h("div", { class: "rc-meets" }, r.meets.map(function (m) {
        var done = meetAdded(m), when = m.date ? longDay(m.date) + (m.from ? " в " + m.from : "") : "день и время не названы";
        return h("div", { class: "rc-meet" }, h("span", { class: "t" }, m.t, h("small", { text: when + " · Звонок · напомнить за час" })),
          done ? h("span", { class: "rc-ok", text: "✓ В календаре" }) :
            h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: function () { recapAddMeet(e, m); } }, "Добавить в календарь"));
      }))));
    return h("div", null, kids);
  }
  function recapTextPane(e) {
    var box = h("div", { class: "rc-lines" });
    function lines() {
      var full = recapUi.text[e.id];
      if (full === undefined) { box.replaceChildren(h("p", { class: "rc-empty", text: "Загружаю текст…" })); return; }
      var q = recapUi.q.trim().toLowerCase();
      var list = full.split(/\r?\n/).filter(function (l) { return l.trim() && (!q || l.toLowerCase().indexOf(q) !== -1); });
      if (!list.length) { box.replaceChildren(h("p", { class: "rc-empty", text: full ? "Ничего не нашлось." : "Текст не сохранён." })); return; }
      box.replaceChildren.apply(box, list.slice(0, 2000).map(function (l) {
        if (!q) return h("div", { class: "rc-line", text: l });
        var i = l.toLowerCase().indexOf(q);
        return h("div", { class: "rc-line" }, l.slice(0, i), h("mark", { text: l.slice(i, i + q.length) }), l.slice(i + q.length));
      }));
    }
    var input = h("input", { type: "search", placeholder: "Найти в тексте: «музыка», «пятница»…", value: recapUi.q, "aria-label": "Поиск по тексту созвона",
      oninput: function () { recapUi.q = this.value; lines(); } });
    if (recapUi.text[e.id] === undefined) {
      api.recapText(e.id).then(function (x) {
        recapUi.text[e.id] = x && x.ok ? x.text || "" : "";
        if (recapUi.tab === "tr" && cal.editing === e.id) lines();
      });
    }
    lines();
    return h("div", { class: "rc-blk" }, h("label", { class: "rc-search", html: ICONS.search || "" }, input), box);
  }
  // «Итоги» of an event that has none yet: paste the text or choose a file right here.
  function renderRecapEmpty(e) {
    var k = kindOfEvent(e);
    var head = h("div", { class: "rc-head" }, h("div", null, h("h2", { text: evName(e) }), h("p", { text: longDay(e.date) + ", " + timeRange(e) + " · " + k.label })));
    var ta = h("textarea", { class: "textarea", rows: "9", placeholder: "Вставьте сюда итоги или расшифровку созвона (Ctrl + V) или нажмите «Выбрать файл…»", "aria-label": "Итоги или расшифровка созвона",
      oninput: function () { recapUi.draft[e.id] = this.value; } });
    ta.value = recapUi.draft[e.id] || "";
    var msg = h("span", { class: "form-msg", role: "status" });
    var go = h("button", { type: "button", class: "btn btn-primary" }, "Разобрать итоги");
    var pick = h("button", { type: "button", class: "btn btn-ghost" }, "Выбрать файл…");
    function fail(text) { msg.classList.add("error"); msg.textContent = text; }
    pick.addEventListener("click", function () {
      api.recapPickFile().then(function (r) {
        if (!r || !r.ok) { fail((r && r.error) || "Файл не открылся."); return; }
        if (r.canceled) return;
        ta.value = recapUi.draft[e.id] = r.text;
        recapUi.fname[e.id] = r.name;
        msg.classList.remove("error");
        msg.textContent = "Файл «" + r.name + "» загружен — нажмите «Разобрать итоги».";
      });
    });
    go.addEventListener("click", function () {
      if (!ta.value.trim()) { fail("Вставьте текст итогов или выберите файл."); ta.focus(); return; }
      msg.classList.remove("error");
      msg.textContent = "Читаю текст и ищу главное. Это занимает до минуты.";
      [ta, go, pick].forEach(function (x) { x.disabled = true; });
      go.textContent = "Разбираю…";
      var back = function (text) { if (cal.editing !== e.id) return; [ta, go, pick].forEach(function (x) { x.disabled = false; }); go.textContent = "Разобрать итоги"; fail(text || "Не получилось. Попробуйте ещё раз."); };
      api.recapMake({ eventId: e.id, text: ta.value, name: recapUi.fname[e.id] || "" }).then(function (r) {
        if (!r || !r.ok) { back(r && r.error); return; }
        applyData(r);
        recapUi.draft[e.id] = ""; recapUi.fname[e.id] = ""; recapUi.picked = {};
        renderCalendar();
        if (cal.editing === e.id) showCalTab("sum");
        toast("Итоги разобраны" + (r.cost > 0 ? " · " + fmtCost(r.cost) : ""));
      }, function () { back(); });
    });
    calRecap.replaceChildren(head,
      h("p", { class: "rd-hint", text: "Вставьте итоги созвона из другой программы (например, Wispr Flow) или расшифровку. Ассистент найдёт главное, решения, следующие шаги и договорённости о новых созвонах." }),
      ta, h("div", { class: "editor-actions" }, go, pick, h("button", { type: "button", class: "btn btn-ghost", onclick: closeEventForm }, "Закрыть"), msg));
  }
  function recapSave(id, mutate) {
    var ev = eventById(id), rc = recapCopy(ev.recap);
    mutate(rc);
    return call(api.recapUpdate(id, rc));
  }
  function recapAddTasks(e) {
    var list = e.recap.steps.filter(function (s) { return recapUi.picked[s.id] && !stepAdded(s); }), made = [], i = 0;
    function done() {
      if (!made.length) return;
      recapSave(e.id, function (rc) { rc.steps.forEach(function (s) { var m = made.find(function (x) { return x.step === s.id; }); if (m) s.added = m.task; }); }).then(function () {
        refreshRecap();
        undoToast("На доску «Задачи» добавлено: " + made.length, function () {
          made.reduce(function (p, m) { return p.then(function () { return call(api.taskDelete(m.task)); }); }, Promise.resolve()).then(function () {
            if (eventById(e.id)) recapSave(e.id, function (rc) { rc.steps.forEach(function (s) { if (made.some(function (x) { return x.step === s.id; })) s.added = ""; }); }).then(refreshRecap);
          });
        });
      });
    }
    (function next() {
      if (i >= list.length) { done(); return; }
      var s = list[i++];
      call(api.taskSave({ title: s.t, due: s.due || "", tags: ["Созвон"],
        note: "Из созвона «" + evName(e) + "», " + longDay(e.date) + (s.who ? ". Исполнитель: " + s.who : "") })).then(function (r) {
        if (r) made.push({ step: s.id, task: r.taskId });
        next();
      });
    })();
  }
  function recapAddMeet(e, m) {
    if (!m.date) {
      // No day was named: the usual form opens with the topic filled in.
      closeEventForm();
      openEventForm(null, m.from || null);
      els.cfTitle.value = m.t;
      els.cfWho.value = e.who || "";
      return;
    }
    call(api.calSave({ date: m.date, from: m.from || "10:00", to: m.to || "", who: e.who || "", title: m.t, kind: "call", remind: 60, note: "" })).then(function (r) {
      if (!r) return;
      recapSave(e.id, function (rc) { rc.meets.forEach(function (x) { if (x.id === m.id) x.added = r.id; }); }).then(function () {
        renderCalendar();
        refreshRecap();
        undoToast("Дело «" + m.t + "» добавлено: " + longDay(m.date), function () {
          call(api.calDelete(r.id)).then(function () { if (eventById(e.id)) recapSave(e.id, function (rc) { rc.meets.forEach(function (x) { if (x.id === m.id) x.added = ""; }); }).then(function () { renderCalendar(); refreshRecap(); }); });
        });
      });
    });
  }

  /* The window for loading a summary: choose the event (or a new one), paste the text or choose a file. */
  var rd = { dlg: $("recap-dlg"), form: $("rd-form"), ev: $("rd-event"), dateField: $("rd-date-field"), date: $("rd-date"), text: $("rd-text"),
    go: $("rd-go"), file: $("rd-file"), cancel: $("rd-cancel"), msg: $("rd-msg"), name: "", busy: false };
  function openRecapLoad(preferId) {
    ensureCal();
    var now = new Date(), nowKey = dayKey(now) + " " + pad2(now.getHours()) + ":" + pad2(now.getMinutes());
    var from = dayKey(addDays(today(), -14)), to = dayKey(addDays(today(), 1));
    var list = state.events.filter(function (e) { return e.date >= from && e.date <= to; })
      .sort(function (a, b) { return (b.date + b.from).localeCompare(a.date + a.from); });
    rd.ev.replaceChildren.apply(rd.ev, [h("option", { value: "", text: "Новое дело — создам само" })].concat(list.map(function (e) {
      return h("option", { value: e.id, text: (e.date === dayKey(now) ? "Сегодня" : longDay(e.date)) + ", " + e.from + " — " + evName(e) + (e.recap ? " · итоги заменятся" : "") });
    })));
    var guess = list.find(function (e) { return (e.kind === "call" || e.kind === "meet") && e.date + " " + e.from <= nowKey; });
    rd.ev.value = preferId || (guess ? guess.id : "");
    rd.dateField.hidden = !!rd.ev.value;
    rd.date.value = dayKey(now);
    rd.text.value = "";
    rd.name = "";
    rd.msg.textContent = "";
    rd.msg.classList.remove("error");
    if (!rd.dlg.open) rd.dlg.showModal();
    rd.text.focus();
  }
  function setRecapBusy(on) {
    rd.busy = on;
    [rd.ev, rd.date, rd.text, rd.file, rd.cancel, rd.go].forEach(function (x) { x.disabled = on; });
    rd.go.textContent = on ? "Разбираю…" : "Разобрать итоги";
  }
  rd.ev.addEventListener("change", function () { rd.dateField.hidden = !!rd.ev.value; });
  rd.cancel.addEventListener("click", function () { if (!rd.busy) rd.dlg.close(); });
  rd.dlg.addEventListener("cancel", function (e) { if (rd.busy) e.preventDefault(); });
  rd.file.addEventListener("click", function () {
    api.recapPickFile().then(function (r) {
      if (!r || !r.ok) { rd.msg.classList.add("error"); rd.msg.textContent = (r && r.error) || "Файл не открылся."; return; }
      if (r.canceled) return;
      rd.text.value = r.text;
      rd.name = r.name;
      rd.msg.classList.remove("error");
      rd.msg.textContent = "Файл «" + r.name + "» загружен — нажмите «Разобрать итоги».";
    });
  });
  rd.form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (rd.busy) return;
    if (!rd.text.value.trim()) { rd.msg.classList.add("error"); rd.msg.textContent = "Вставьте текст итогов или выберите файл."; rd.text.focus(); return; }
    rd.msg.classList.remove("error");
    rd.msg.textContent = "Читаю текст и ищу главное. Это занимает до минуты.";
    setRecapBusy(true);
    var fail = function (msg) { setRecapBusy(false); rd.msg.classList.add("error"); rd.msg.textContent = msg || "Не получилось. Попробуйте ещё раз."; };
    api.recapMake({ eventId: rd.ev.value || "", date: rd.date.value, text: rd.text.value, name: rd.name }).then(function (r) {
      if (!r || !r.ok) { fail(r && r.error); return; }
      applyData(r);
      setRecapBusy(false);
      rd.dlg.close();
      selectDay(r.date);
      var ev = eventById(r.eventId);
      if (ev) { openEventForm(ev); showCalTab("sum"); }
      toast((r.created ? "Создал дело и разобрал итоги" : "Итоги разобраны") + (r.cost > 0 ? " · " + fmtCost(r.cost) : ""));
    }, function () { fail(); });
  });
  $("cal-recap-btn").addEventListener("click", function () { openRecapLoad(); });

  /* The calendar assistant bar: the same as above the tasks, but it only knows the calendar. */
  var cbar = { el: $("cbar"), input: $("cbar-input"), model: $("cbar-model"), send: $("cbar-send"), busy: false };
  function growCbar() {
    if (!cbar.input.value) { cbar.input.style.height = ""; return; }
    cbar.input.style.height = "auto";
    cbar.input.style.height = Math.min(cbar.input.scrollHeight, 150) + "px";
  }
  function renderCbar() {
    cbar.model.textContent = quickModelName();
    cbar.el.classList.toggle("busy", cbar.busy);
    cbar.input.disabled = cbar.busy;
    cbar.send.disabled = cbar.busy || !cbar.input.value.trim();
    cbar.send.title = cbar.busy ? "Ассистент разбирает…" : "Отправить (Enter)";
  }
  function sendCbar(text) {
    var v = String(text || "").trim();
    if (!v || cbar.busy) return;
    cbar.busy = true;
    cbar.input.value = "";
    growCbar();
    renderCbar();
    var fail = function (msg) {
      cbar.busy = false;
      if (!cbar.input.value) { cbar.input.value = v; growCbar(); }
      renderCbar();
      taskNote({ text: msg || "Ассистент не ответил. Попробуйте ещё раз.", failed: true });
    };
    api.calAssistant(v).then(function (r) {
      if (!r || !r.ok) { fail(r && r.error); return; }
      applyData(r);
      cbar.busy = false;
      render();
      renderCbar();
      taskNote({ text: r.reply, failed: r.failed, undoId: r.undoId, cost: r.cost, undoFn: api.calAssistantUndo, undoText: "Отменил: календарь вернулся как был до этого сообщения." });
      if (state.page === "calendar") cbar.input.focus();
    }, function () { fail(); });
  }
  cbar.el.addEventListener("submit", function (e) { e.preventDefault(); sendCbar(cbar.input.value); });
  cbar.input.addEventListener("input", function () { growCbar(); cbar.send.disabled = cbar.busy || !cbar.input.value.trim(); });
  cbar.input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.isComposing) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        cbar.input.setRangeText("\n", cbar.input.selectionStart, cbar.input.selectionEnd, "end");
        cbar.input.dispatchEvent(new Event("input"));
      } else if (!e.shiftKey && !e.altKey) {
        e.preventDefault();
        sendCbar(cbar.input.value);
      }
    } else if (e.key === "Escape" && cbar.input.value) {
      e.stopPropagation();
      cbar.input.value = "";
      cbar.input.dispatchEvent(new Event("input"));
    }
  });
  renderCbar();

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
  // "В процессе · срок Завтра 15:00 · Срочная · Монтаж"; without the column when noColumn.
  function taskSummary(t, noColumn) {
    var parts = noColumn ? [] : [colName(t.status)];
    if (t.due) parts.push("срок " + dueInfo(t).text);
    if (t.priority) parts.push(PRIORITIES[t.priority]);
    if (t.tags && t.tags.length) parts.push(t.tags.join(", "));
    return parts.join(" · ");
  }
  function taskCard(msg, a) {
    var t = a.task || {};
    var kind = a.kind === "task-add" ? "add" : a.kind === "task-update" ? "update" : "delete";
    var head = { add: "Добавить задачу «", update: "Изменить задачу «", delete: "Удалить задачу «" }[kind] + (t.title || a.title) + "»?";
    var kids = [h("div", { class: "act-head" }, h("span", { class: "ico", html: kind === "delete" ? ICONS.trash : ICONS.tasks, "aria-hidden": "true" }), h("span", { text: head }))];
    if (kind === "update" && a.prevTask) {
      kids.push(h("div", { class: "act-when was", text: "Было: «" + a.prevTask.title + "», " + taskSummary(a.prevTask) }),
        h("div", { class: "act-when", text: "Станет: «" + t.title + "», " + taskSummary(t) }));
    } else kids.push(h("div", { class: "act-when", text: "Столбец «" + colName(t.status) + "»" + (taskSummary(t, true) ? " · " + taskSummary(t, true) : "") + (t.note ? " · " + t.note : "") }));
    if (kind === "add" && t.subtasks && t.subtasks.length) kids.push(h("div", { class: "act-when", text: "Шаги: " + t.subtasks.map(function (s) { return s.title; }).join(", ") }));
    var done = { add: "Задача добавлена", update: "Задача изменена", delete: "Задача удалена" }[kind];
    var foot = cardFooter(msg, a, done, "Отменено, задачи не изменились", kind === "delete" ? null : function () { setPage("tasks"); });
    kids.push(foot || cardButtons(msg, a, { add: "Добавить", update: "Изменить", delete: "Удалить" }[kind], kind === "delete"));
    return h("div", { class: "act-card" + (a.status && a.status !== "busy" ? " settled" : "") }, kids);
  }
  // «Сохранить скилл …?»: the file from the message goes to «Промты» → «Скиллы» with the title, type and description the model wrote.
  function skillCard(msg, a) {
    var t = skillType(a.category);
    var kids = [
      h("div", { class: "act-head" }, icon("doc"), h("span", { text: "Сохранить скилл «" + a.title + "»?" })),
      h("div", { class: "act-meta" }, h("span", { class: "chip " + (t ? t.cls : "cat-other"), text: t ? t.label : "Тип выберете потом" })),
      a.text ? h("div", { class: "act-text sk-act-text", text: a.text }) : null
    ];
    var foot = cardFooter(msg, a, "Скилл сохранён во вкладку «Скиллы»", "Отменено, ничего не сохранено", function () { openSkills(); });
    kids.push(foot || cardButtons(msg, a, "Сохранить"));
    return h("div", { class: "act-card" + (a.status && a.status !== "busy" ? " settled" : "") }, kids);
  }
  function actionCard(msg, a) {
    if (/^calendar-/.test(a.kind)) return calendarCard(msg, a);
    if (/^task-/.test(a.kind)) return taskCard(msg, a);
    if (a.kind === "skill-add") return skillCard(msg, a);
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
    "task-add": "Задача «%» добавлена", "task-update": "Задача «%» изменена", "task-delete": "Задача «%» удалена", "create-prompt": "Промт «%» добавлен",
    "skill-add": "Скилл «%» сохранён во вкладку «Скиллы»"
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

  // images: the message's pictures [{ id, name, stored }] (only user messages in LLM have them).
  function addMessage(role, text, se, images) {
    se = se || chat;
    if (se === chat) els.chatEmpty.hidden = true;
    if (se === quick) els.qaEmpty.hidden = true;
    var msg = { role: role, text: text || "" };
    if (role === "user") {
      msg.images = images && images.length ? images.slice() : null;
      var chatId = se.id;
      var imgs = msg.images ? msg.images.filter(function (im) { return !isChatDoc(im.stored); }) : [];
      var docs = msg.images ? msg.images.filter(function (im) { return isChatDoc(im.stored); }) : [];
      var pics = imgs.length ? h("div", { class: "bubble-imgs" + (imgs.length > 1 ? " many" : "") }, imgs.map(function (im) {
        return h("button", { type: "button", class: "bubble-img", title: im.name + " — открыть", onclick: function () { call(api.chatImageOpen(chatId, im.stored)); } },
          h("img", { src: chatImageUrl(chatId, im.stored), alt: im.name }));
      })) : null;
      // Skill files (.md, .zip): a chip with the name; a click opens the file in Windows.
      var files = docs.length ? h("div", { class: "bubble-docs" }, docs.map(function (im) {
        return h("button", { type: "button", class: "bubble-doc", title: im.name + " — открыть", onclick: function () { call(api.chatImageOpen(chatId, im.stored)); } },
          h("b", { text: docExt(im.stored) }), h("span", { text: im.name }));
      })) : null;
      msg.el = h("div", { class: "msg msg-user" }, h("div", { class: "bubble" }, pics, files, msg.text ? h("span", { text: msg.text }) : null));
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
      : a.kind === "task-add" ? "Добавить задачу «" + t.title + "» в «" + colName(t.status) + "»"
      : a.kind === "task-update" ? "Изменить задачу «" + t.title + "»: столбец «" + colName(t.status) + "»"
      : a.kind === "task-delete" ? "Удалить задачу «" + t.title + "»"
      : a.kind === "skill-add" ? "Сохранить скилл «" + a.title + "» во вкладку «Скиллы»"
      : "Создать промт «" + a.title + "»";
    var how = a.status === "done" ? "сделано" : a.status === "canceled" ? "пользователь отменил" : a.status === "undone" ? "сделано, но пользователь отменил"
      : a.status === "failed" ? "не получилось" : "пользователь не ответил";
    return "[Карточка: " + what + " — " + how + "]";
  }
  function history(se) {
    return (se || chat).messages.filter(function (m) { return (m.text || m.images || (m.actions && m.actions.length)) && !m.streaming; }).map(function (m) {
      var content = m.text;
      if (m.actions && m.actions.length) content = (content ? content + "\n\n" : "") + m.actions.map(cardOutcome).join("\n");
      var out = { role: m.role, content: content };
      if (m.images) {
        var pics = m.images.filter(function (im) { return !isChatDoc(im.stored); }), docs = m.images.filter(function (im) { return isChatDoc(im.stored); });
        if (pics.length) out.images = pics.map(function (im) { return im.stored; });
        if (docs.length) out.docs = docs.map(function (im) { return { stored: im.stored, name: im.name }; });
      }
      return out;
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
    api.assistantSend(history(se), se.quick ? { quick: true } : { chatId: se.id }).then(function (r) {
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
    var pics = (se.attach || []).filter(function (a) { return a.stored; });
    if ((!text.trim() && !pics.length) || se.current) return;
    if ((se.attach || []).some(function (a) { return !a.stored; })) { toast("Картинка ещё загружается, секунду."); return; }
    if (!se.id) se.id = newChatId();
    if (!se.title) se.title = (text.trim() || "Вложение: " + pics.map(function (a) { return a.name; }).join(", ")).replace(/\s+/g, " ").slice(0, 70);
    se.attach = [];
    if (se === chat) renderAttach();
    addMessage("user", text, se, pics.map(function (a) { return { id: a.id, name: a.name, stored: a.stored }; }));
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
    return se.messages.filter(function (m) { return !m.streaming && (m.text || m.images || m.note || (m.actions && m.actions.length)); }).map(function (m) {
      var out = { role: m.role, text: m.text };
      if (m.images) out.images = m.images;
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
    se.attach = [];
    if (se === chat) renderAttach();
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
    renderAttach();
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
        var msg = addMessage(m.role, m.text, se, m.images);
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

  /* ---------- pictures for LLM messages ---------- */
  // A picture is made smaller right here (the long side at most 2048 px, JPEG), saved beside the conversation
  // ("Файлы чатов/<id>/") and shown above the message box until it is sent with the next message.
  var ATTACH_MAX = 6, IMAGE_SIDE = 2048;
  function chatImageUrl(chatId, stored) {
    var dir = state.info && state.info.dataDir;
    if (!dir || !chatId) return "";
    var parts = (dir + "/Файлы чатов/" + chatId + "/" + stored).split(/[\\/]+/);
    return "file:///" + parts.map(function (p, i) { return i === 0 && /^[A-Za-z]:$/.test(p) ? p : encodeURIComponent(p); }).join("/");
  }
  function shrinkImage(file) {
    return createImageBitmap(file).then(function (bmp) {
      var k = Math.min(1, IMAGE_SIDE / Math.max(bmp.width, bmp.height));
      var w = Math.max(1, Math.round(bmp.width * k)), hgt = Math.max(1, Math.round(bmp.height * k));
      var canvas = new OffscreenCanvas(w, hgt), ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, hgt);
      ctx.drawImage(bmp, 0, 0, w, hgt);
      bmp.close();
      return canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    }).then(function (blob) { return blob.arrayBuffer(); });
  }
  function addChatImages(files) {
    var se = chat;
    if (state.page !== "assistant") return;
    var docs = Array.prototype.filter.call(files || [], function (f) { return /\.(md|markdown|zip)$/i.test(f.name); });
    var list = Array.prototype.filter.call(files || [], function (f) { return /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name); });
    if (!list.length && !docs.length) { toast("Приложить можно картинки и скиллы — файлы .md или .zip."); return; }
    se.attach = se.attach || [];
    if (docs.length) addChatDocs(se, docs);
    if (!list.length) return;
    var room = ATTACH_MAX - se.attach.length;
    if (room <= 0) { toast("В одно сообщение — не больше " + ATTACH_MAX + " картинок."); return; }
    if (list.length > room) toast("В одно сообщение — не больше " + ATTACH_MAX + " картинок, лишние не добавлены.");
    if (!se.id) se.id = newChatId();
    list.slice(0, room).forEach(function (f) {
      var a = { name: f.name || "картинка", stored: null, preview: URL.createObjectURL(f) };
      se.attach.push(a);
      shrinkImage(f).then(function (buf) {
        return api.chatImageSave(se.id, a.name, new Uint8Array(buf), "jpg");
      }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || "save");
        if (se.attach.indexOf(a) === -1) { api.chatImageRemove(se.id, r.image.stored); return; }   // removed while saving
        a.id = r.image.id; a.stored = r.image.stored; a.name = r.image.name;
        if (se === chat) renderAttach();
      }).catch(function (e) {
        var i = se.attach.indexOf(a);
        if (i !== -1) se.attach.splice(i, 1);
        URL.revokeObjectURL(a.preview);
        if (se === chat) renderAttach();
        toast(e && e.message && e.message !== "save" ? e.message : "Не получилось прочитать картинку «" + a.name + "».");
      });
    });
    renderAttach();
    updateCostHint();
    els.chatInput.focus();
  }
  // Skill files (.md, .zip) go as they are (at most 20 MB); the model gets their text and can keep them in «Скиллы».
  function isChatDoc(stored) { return /\.(md|zip)$/i.test(String(stored || "")); }
  function docExt(name) { return /\.zip$/i.test(String(name || "")) ? "zip" : "md"; }
  function addChatDocs(se, files) {
    var room = ATTACH_MAX - se.attach.length;
    if (room <= 0) { toast("В одно сообщение — не больше " + ATTACH_MAX + " файлов."); return; }
    if (!se.id) se.id = newChatId();
    Array.prototype.slice.call(files, 0, room).forEach(function (f) {
      var a = { name: f.name, stored: null, doc: true };
      se.attach.push(a);
      f.arrayBuffer().then(function (buf) {
        return api.chatFileSave(se.id, f.name, new Uint8Array(buf));
      }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || "save");
        if (se.attach.indexOf(a) === -1) { api.chatImageRemove(se.id, r.image.stored); return; }   // removed while saving
        a.id = r.image.id; a.stored = r.image.stored; a.name = r.image.name;
        if (se === chat) renderAttach();
      }).catch(function (e) {
        var i = se.attach.indexOf(a);
        if (i !== -1) se.attach.splice(i, 1);
        if (se === chat) renderAttach();
        toast(e && e.message && e.message !== "save" ? e.message : "Не получилось прочитать файл «" + a.name + "».");
      });
    });
    renderAttach();
    updateCostHint();
    els.chatInput.focus();
  }
  function renderAttach() {
    var list = chat.attach || [];
    els.chatAtt.hidden = !list.length;
    els.chatAtt.replaceChildren.apply(els.chatAtt, list.map(function (a) {
      return h("div", { class: "att-thumb" + (a.doc ? " att-doc" : "") + (a.stored ? "" : " loading"), title: a.name },
        a.doc ? h("span", { class: "att-doc-in" }, h("b", { text: docExt(a.name) }), h("span", { text: a.name }))
          : h("img", { src: a.preview || chatImageUrl(chat.id, a.stored), alt: a.name }),
        h("button", { type: "button", class: "att-x", title: "Убрать", "aria-label": "Убрать картинку «" + a.name + "»", html: ICONS.x, onclick: function () {
          var i = chat.attach.indexOf(a);
          if (i !== -1) chat.attach.splice(i, 1);
          if (a.stored) api.chatImageRemove(chat.id, a.stored);
          renderAttach();
          updateCostHint();
        } }));
    }));
  }
  // «Отправить снимок в LLM» in «Снимки» (here or in the separate editor): a new LLM tab with the picture attached.
  api.onCaptureLlm(function (shot) {
    if (!shot || !shot.bytes) return;
    openTab("assistant", { fresh: true });
    addChatImages([new File([shot.bytes], (shot.name || "Снимок") + ".png", { type: "image/png" })]);
  });
  els.chatAttach.addEventListener("click", function () { els.chatFile.value = ""; els.chatFile.click(); });
  els.chatFile.addEventListener("change", function () { if (els.chatFile.files.length) addChatImages(els.chatFile.files); });
  els.chatInput.addEventListener("paste", function (e) {
    var cd = e.clipboardData;
    if (!cd || !cd.files || !cd.files.length) return;
    e.preventDefault();
    addChatImages(cd.files);
  });

  // The box grows with the text. While the LLM page is hidden its height cannot be measured (it would be 0),
  // so then it keeps its usual one-line height and is measured again when the page shows.
  function growInput() {
    var t = els.chatInput;
    if (t.offsetParent === null) { t.style.height = ""; updateCostHint(); return; }
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
    chat.messages.forEach(function (m) { chars += (m.text || "").length + (m.images ? m.images.length * 4500 : 0); });
    chars += (chat.attach || []).length * 4500;
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

  /* ---------- focus timer ---------- */
  // A plain countdown above "Статистика": started here or by the assistant, not tied to anything. main.js keeps it
  // (the same in every window, it survives a restart); when time is up the main window plays a melody until "Выключить".
  var TIMER_PRESETS = [5, 10, 15, 25, 30, 45, 60, 90];
  var tm = { state: "idle", duration: 0, endsAt: 0, left: 0, pop: false, last: 25 };
  try { tm.last = Math.min(240, Math.max(1, +localStorage.getItem("timerLast") || 25)); } catch (e) {}
  var TICONS = {
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9.5 3h5M12 3v2.5"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5.5" width="3.6" height="13" rx="1.2"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1.2"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>'
  };
  function timerLeft() { return tm.state === "running" ? Math.max(0, tm.endsAt - Date.now()) : tm.left; }
  function fmtLeft(ms) {
    var sec = Math.ceil(ms / 1000), hh = Math.floor(sec / 3600), mm = Math.floor(sec % 3600 / 60), ss = sec % 60;
    return (hh ? hh + ":" + pad2(mm) : mm) + ":" + pad2(ss);
  }
  function timerCmd(cmd, arg) { return call(api.timer(cmd, arg)).then(function (r) { if (r && r.timer) applyTimer(r.timer); }); }
  function startTimerUi(min) {
    min = Math.round(Math.min(240, Math.max(1, +min || 0)));
    if (!min) return;
    tm.last = min;
    try { localStorage.setItem("timerLast", String(min)); } catch (e) {}
    tm.pop = false;
    timerCmd("start", min);
  }
  function applyTimer(t) {
    var was = tm.state;
    tm.state = t.state; tm.duration = t.duration; tm.endsAt = t.endsAt; tm.left = t.left;
    // The clocks of the window and main.js are the same machine's, so the end time can be counted here.
    if (tm.state === "running") tm.endsAt = Date.now() + t.left;
    if (tm.state === "ringing" && was !== "ringing" && isMainWindow) playChime();
    if (tm.state !== "ringing") stopChime();
    renderTimer();
  }
  function renderTimer() {
    var row = els.timerRow, st = tm.state, left = timerLeft();
    row.className = "timer-row " + st;
    var kids;
    if (st === "idle") {
      kids = [h("button", { type: "button", class: "nav-item timer-main", title: "Таймер для фокуса", "aria-expanded": String(tm.pop),
        onclick: function () { setTimerPop(!tm.pop); } }, h("span", { class: "ico", html: TICONS.clock, "aria-hidden": "true" }), h("span", { text: "Таймер" }))];
    } else if (st === "ringing") {
      kids = [h("button", { type: "button", class: "nav-item timer-main", title: "Выключить мелодию", onclick: function () { timerCmd("stop"); } },
        h("span", { class: "ico", html: TICONS.clock, "aria-hidden": "true" }), h("span", { text: "Время вышло!" }), h("span", { class: "timer-time", text: "Выключить" }))];
    } else {
      var fill = h("span", { class: "timer-fill", "aria-hidden": "true" });
      fill.style.width = (tm.duration ? Math.min(100, (1 - left / tm.duration) * 100) : 0) + "%";
      kids = [
        h("button", { type: "button", class: "nav-item timer-main", title: st === "paused" ? "Таймер на паузе" : "Идёт таймер", "aria-expanded": String(tm.pop),
          onclick: function () { setTimerPop(!tm.pop); } },
          h("span", { class: "ico", html: TICONS.clock, "aria-hidden": "true" }), h("span", { text: st === "paused" ? "Пауза" : "Фокус" }),
          h("span", { class: "timer-time", text: fmtLeft(left) })),
        h("button", { type: "button", class: "timer-ico", title: st === "paused" ? "Продолжить" : "Пауза", "aria-label": st === "paused" ? "Продолжить" : "Пауза",
          html: st === "paused" ? ICONS.play : TICONS.pause, onclick: function () { timerCmd(st === "paused" ? "resume" : "pause"); } }),
        h("button", { type: "button", class: "timer-ico", title: "Остановить", "aria-label": "Остановить таймер", html: TICONS.stop, onclick: function () { timerCmd("stop"); } }),
        fill
      ];
    }
    row.replaceChildren.apply(row, kids);
    els.timerPop.hidden = !tm.pop;
    if (tm.pop) renderTimerPop();
  }
  // The panel: presets and an own number of minutes; while it runs — "+5 минут", pause and stop.
  function renderTimerPop() {
    var st = tm.state, kids = [h("h3", { text: "Таймер" })];
    if (st === "running" || st === "paused") {
      kids.push(h("p", { text: (st === "paused" ? "На паузе, осталось " : "Осталось ") + fmtLeft(timerLeft()) + (st === "running" ? " · закончится в " + timeOf(new Date(tm.endsAt)) : "") }),
        h("div", { class: "timer-acts" },
          h("button", { type: "button", class: "btn btn-ghost", onclick: function () { timerCmd("add", 5); } }, "+5 минут"),
          h("button", { type: "button", class: "btn btn-ghost", onclick: function () { timerCmd(st === "paused" ? "resume" : "pause"); } }, st === "paused" ? "Продолжить" : "Пауза"),
          h("button", { type: "button", class: "btn btn-ghost", onclick: function () { tm.pop = false; timerCmd("stop"); } }, "Остановить")),
        h("p", { text: "Начать заново:" }));
    } else kids.push(h("p", { text: "Сколько минут? Когда время выйдет, сыграет мелодия." }));
    kids.push(h("div", { class: "timer-presets" }, TIMER_PRESETS.map(function (m) {
      return h("button", { type: "button", onclick: function () { startTimerUi(m); } }, m + " мин");
    })));
    var own = h("input", { class: "input", type: "number", min: "1", max: "240", step: "1", value: String(tm.last), "aria-label": "Своё время, минут" });
    own.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); startTimerUi(own.value); } });
    kids.push(h("div", { class: "timer-own" }, own, h("span", { text: "мин" }), h("button", { type: "button", class: "btn btn-primary", onclick: function () { startTimerUi(own.value); } }, "Старт")));
    els.timerPop.replaceChildren.apply(els.timerPop, kids);
  }
  function timeOf(d) { return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  function setTimerPop(open) {
    tm.pop = open;
    els.timerPop.hidden = !open;
    renderTimer();
    if (open) { var b = els.timerPop.querySelector(".timer-presets button"); if (b) b.focus(); }
  }
  els.timerPop.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.preventDefault(); setTimerPop(false); } });
  document.addEventListener("mousedown", function (e) {
    if (!els.timerPop.hidden && !els.timerPop.contains(e.target) && !els.timerRow.contains(e.target)) setTimerPop(false);
  });
  // Every second while it runs; the panel's "осталось" too.
  setInterval(function () {
    if (tm.state !== "running") return;
    var main = els.timerRow.querySelector(".timer-time"), fill = els.timerRow.querySelector(".timer-fill"), left = timerLeft();
    if (main) main.textContent = fmtLeft(left);
    if (fill) fill.style.width = (tm.duration ? Math.min(100, (1 - left / tm.duration) * 100) : 0) + "%";
    if (tm.pop) renderTimerPop();
  }, 1000);
  api.onTimer(applyTimer);

  // The melody: soft bells made right here (no sound files), three rounds, about 9 seconds; "Выключить" stops it.
  var chime = { ctx: null, stop: null };
  function bell(ctx, freq, at) {
    var g = ctx.createGain(), o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g2 = ctx.createGain();
    o1.type = "sine"; o1.frequency.value = freq;
    o2.type = "sine"; o2.frequency.value = freq * 2.01;
    g2.gain.value = 0.22;
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 1.8);
    o1.start(at); o2.start(at); o1.stop(at + 1.9); o2.stop(at + 1.9);
  }
  function playChime() {
    stopChime();
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    var ctx = new Ctx(), notes = [659.25, 783.99, 1046.5, 783.99, 1318.51];
    for (var round = 0; round < 3; round++) notes.forEach(function (f, i) { bell(ctx, f, ctx.currentTime + 0.05 + round * 3 + i * 0.3); });
    chime.ctx = ctx;
    chime.stop = setTimeout(stopChime, 9500);
  }
  function stopChime() {
    clearTimeout(chime.stop);
    if (chime.ctx) { try { chime.ctx.close(); } catch (e) {} chime.ctx = null; }
  }

  /* ---------- tasks board (beta) ---------- */
  // Three columns: «Предстоит», «В процессе», «Готово». A card shows the title and marks (importance, tags, due day,
  // subtasks, note); the circle on the left ticks it off into «Готово» and back to where it was. A click opens the whole
  // task in the panel on the right (renderTaskPanel). Cards are dragged between columns (or up and down).
  // Above the board is the tasks assistant bar (renderTbar). Stored in tasks.json.
  var BASE_COLS = [{ id: "todo", name: "Предстоит", base: true }, { id: "doing", name: "В процессе", base: true }, { id: "done", name: "Готово", base: true }];
  var PRIORITIES = ["Обычная", "Важная", "Срочная"];
  var TASK_TAGS = ["Монтаж", "Съёмка", "Сценарий", "Промты", "Публикация", "Сайт", "Обучение", "Звонок", "Генерация"];
  var TASK_WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];   // by getDay(); the calendar has its own WEEKDAYS_SHORT from Monday
  // open: the task in the panel; fresh: tasks the assistant just changed (they flash once); focusSub: back to the subtask field;
  // colMenu: the column whose «⋯» menu is open; renaming: the column being renamed; newCol: the «+ Столбец» field is open.
  var tb = { adding: null, dragId: null, focus: false, open: null, fresh: [], focusSub: false, colMenu: null, renaming: null, newCol: false };
  // What is shown: board or list, search, tag, importance (1 — important and urgent, 2 — urgent only), done tasks hidden.
  var tf = { view: "board", q: "", tag: "", prio: 0, hideDone: false, doneOpen: false };
  try {
    if (["list", "archive"].indexOf(localStorage.getItem("tasksView")) !== -1) tf.view = localStorage.getItem("tasksView");
    tf.hideDone = localStorage.getItem("tasksHideDone") === "1";
  } catch (e) {}
  function findTask(id) { return state.tasks.find(function (t) { return t.id === id; }) || null; }
  // All columns in their order: «Предстоит», «В процессе», the user's own, «Готово».
  function taskCols() { return state.taskColumns && state.taskColumns.length ? state.taskColumns : BASE_COLS; }
  function sortTasks() {
    var ids = taskCols().map(function (c) { return c.id; });
    state.tasks.sort(function (a, b) { return ids.indexOf(a.status) - ids.indexOf(b.status) || a.order - b.order; });
  }
  function saveTaskNow(t) { return call(api.taskSave(t)).then(function (r) { render(); return r; }); }
  function colOf(id) { return taskCols().find(function (x) { return x.id === id; }) || BASE_COLS[0]; }
  function colName(id) { return colOf(id).name; }
  // The colour of a column: its own for the three base ones, one of six for the user's.
  function colClass(id) { var c = colOf(id); return c.base ? "tc-" + c.id : "tcc-" + (c.color || 0); }
  // The same tag always gets the same of six colours.
  function tagClass(tag) {
    var n = 0, s = String(tag).toLowerCase();
    for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 997;
    return "tg-" + (n % 6);
  }
  // "Сегодня", "Завтра 15:00", "Пн, 26 октября", "3 ноября"; late — the day has passed and the task is not done.
  function dueInfo(t) {
    var d = new Date(t.due + "T00:00"), today = new Date(), n = Math.round((d - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 864e5);
    var text = n === 0 ? "Сегодня" : n === 1 ? "Завтра" : n === -1 ? "Вчера" : n > 1 && n < 7 ? TASK_WEEKDAYS[d.getDay()] + ", " + fmtDay(d) : fmtDay(d, d.getFullYear() !== today.getFullYear());
    var open = t.status !== "done";
    return { text: text + (t.time ? " " + t.time : ""), late: open && n < 0, today: open && n === 0 };
  }
  function taskBar(done, all) {
    var fill = h("span");
    fill.style.width = (all ? done / all * 100 : 0) + "%";
    return h("span", { class: "tmini", "aria-hidden": "true" }, fill);
  }
  function taskMarks(t, noDue) {
    var marks = [];
    if (t.priority) marks.push(h("span", { class: "tmark p" + t.priority }, PRIORITIES[t.priority]));
    (t.tags || []).forEach(function (g) { marks.push(h("span", { class: "tmark tag " + tagClass(g) }, g)); });
    if (t.due && !noDue) {
      var d = dueInfo(t);
      marks.push(h("span", { class: "tmark due" + (d.late ? " late" : d.today ? " today" : ""), title: d.late ? "Срок прошёл" : "Срок" }, icon("calendar"), d.text));
    }
    var subs = t.subtasks || [];
    if (subs.length) {
      var done = subs.filter(function (s) { return s.done; }).length;
      marks.push(h("span", { class: "tmark", title: "Подзадачи: сделано " + done + " из " + subs.length }, taskBar(done, subs.length), done + "/" + subs.length));
    }
    if (t.note) marks.push(h("span", { class: "tmark", title: t.note.slice(0, 300) }, icon("note")));
    return marks.length ? h("div", { class: "task-marks" }, marks) : null;
  }
  // The circle: ticks the task off into «Готово»; taking the tick off puts it back where it was.
  function taskCheck(t, big) {
    var done = t.status === "done";
    return h("button", {
      type: "button", class: "tchk" + (done ? " on" : "") + (big ? " big" : ""), html: ICONS.check,
      title: done ? "Снять галочку" : "Отметить сделанной", "aria-pressed": done ? "true" : "false",
      "aria-label": (done ? "Снять галочку с задачи «" : "Отметить сделанной задачу «") + t.title + "»",
      onclick: function (e) { e.stopPropagation(); saveTaskNow({ id: t.id, status: done ? t.doneFrom || "todo" : "done" }); }
    });
  }
  function renderTasks() {
    var everything = state.tasks || [];
    var archived = everything.filter(function (t) { return t.archivedAt; });
    var all = everything.filter(function (t) { return !t.archivedAt; });   // on the board
    var done = all.filter(function (t) { return t.status === "done"; }).length;
    var today = dayKey(new Date());
    var late = all.filter(function (t) { return t.status !== "done" && t.due && t.due < today; }).length;
    els.tasksMeta.textContent = (all.length ? all.length + " " + plural(all.length, "задача", "задачи", "задач") + (done ? ", готово " + done : "") + (late ? ", срок прошёл у " + late : "")
      : "Пока задач нет: напишите ассистенту или добавьте первую в столбец «Предстоит»") + (archived.length ? ", в архиве " + archived.length : "");
    renderTbar();
    renderTaskFilters();
    var filtered = tf.q || tf.tag || tf.prio;
    var shown = all.filter(function (t) { return taskVisible(t); });
    els.board.hidden = tf.view !== "board";
    els.tlist.hidden = tf.view === "board";
    els.boardHint.hidden = tf.view !== "board";
    if (tf.view === "archive") { renderTaskArchive(archived.filter(function (t) { return taskVisible(t, true); })); return; }
    if (tf.view === "list") { renderTaskList(shown); return; }
    var cols = taskCols().map(function (c, ci) {
      var list = shown.filter(function (t) { return t.status === c.id; });
      var col = h("section", { class: "tcol " + colClass(c.id), "aria-label": c.name },
        columnHead(c, ci, list.length),
        list.map(taskItem),
        !list.length && filtered ? h("p", { class: "tcol-empty", text: "Под фильтр ничего не подходит" }) : null,
        c.id === "done" ? archiveRow(done) : addRow(c.id));
      col.addEventListener("dragover", function (e) { if (!tb.dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; col.classList.add("drop"); });
      col.addEventListener("dragleave", function (e) { if (!col.contains(e.relatedTarget)) col.classList.remove("drop"); });
      col.addEventListener("drop", function (e) {
        if (!tb.dragId) return;
        e.preventDefault();
        col.classList.remove("drop");
        dropTask(c.id, e.target.closest(".task[data-id]"), list);
      });
      return col;
    });
    els.board.replaceChildren.apply(els.board, cols.concat([newColumnBox()]));
    var ren = els.board.querySelector(".tcol-in");
    if (ren && document.activeElement !== ren) { ren.focus(); ren.select(); }
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
    var cls = "task" + (t.status === "done" ? " is-done" : "") + (tb.open === t.id ? " sel" : "") + (tb.fresh.indexOf(t.id) !== -1 ? " fresh" : "");
    var el = h("div", { class: cls, draggable: "true", "data-id": t.id, tabindex: "0", title: "Нажмите, чтобы открыть задачу. Перетащите в другой столбец",
      onclick: function () { openTask(t.id); },
      onkeydown: function (e) { if (e.key === "Enter" && e.target === el) openTask(t.id); } },
      taskCheck(t), h("span", { class: "task-t", text: t.title }), taskMarks(t));
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

  /* ---------- «Скиллы» on the «Промты» page (mockups/skills.html) ----------
     A skill is an instruction for assistants: one .md file or a .zip archive, kept as it was (main.js skill-*, storage.js addSkill).
     The switch «Промты / Скиллы» under the title picks the list (remembered as libView). A skill comes from «Добавить скилл»
     (Ctrl + N here), by dropping .md/.zip on the page, or from LLM (the skill_add card). Its description (5–6 sentences)
     and type are written by GPT-6.1 Sol (without a ChatGPT key, Claude Haiku); both can be changed by hand. */
  var SKILL_TYPES = [
    { key: "static", label: "Статика", cls: "cat-static" },
    { key: "video", label: "Видео", cls: "cat-video" },
    { key: "code", label: "Code", cls: "cat-code" }
  ];
  // draft: the new skill's form ({ path, name, size, kind, files, title, type, desc }); edit: { id, title, type, desc } of the row being changed;
  // open: rows with «Что внутри» unfolded; busy: skills whose description is being written; errors: id -> { error, nokey }.
  var sk = { query: "", type: "all", draft: null, edit: null, confirmId: null, open: new Set(), busy: new Set(), errors: {}, more: new Set() };
  try { if (localStorage.getItem("libView") === "skills") state.lib = "skills"; } catch (e) { /* the prompts by default */ }
  var skEls = {
    row: $("lib-row"), seg: $("lib-seg"), nPrompts: $("lib-n-prompts"), nSkills: $("lib-n-skills"), add: $("skill-add-btn"),
    view: $("skills-view"), formSlot: $("skill-form-slot"), toolbar: $("sk-toolbar"), search: $("sk-search"), filters: $("sk-filters"),
    table: $("sk-table"), rows: $("sk-rows"), state: $("sk-state")
  };
  function skillType(key) { for (var i = 0; i < SKILL_TYPES.length; i++) if (SKILL_TYPES[i].key === key) return SKILL_TYPES[i]; return null; }
  function findSkill(id) { return state.skills.find(function (s) { return s.id === id; }) || null; }
  function modelLabel(id) { var m = MODELS.find(function (x) { return x.id === id; }); return m ? m.name : id; }
  function setLib(lib) {
    state.lib = lib === "skills" ? "skills" : "prompts";
    try { localStorage.setItem("libView", state.lib); } catch (e) { /* only a convenience */ }
    render();
  }
  function openSkills() { setPage("prompts"); setLib("skills"); }
  skEls.seg.addEventListener("click", function (e) { var b = e.target.closest("button[data-lib]"); if (b) setLib(b.dataset.lib); });

  function skillMatches(s) {
    if (sk.type !== "all" && s.type !== sk.type) return false;
    var q = norm(sk.query);
    if (!q) return true;
    return norm(s.title).indexOf(q) !== -1 || norm(s.desc).indexOf(q) !== -1 || norm(s.text).indexOf(q) !== -1 ||
      norm(s.file.name).indexOf(q) !== -1 || s.inside.some(function (f) { return norm(f.path).indexOf(q) !== -1; });
  }
  function skillFileLine(s) {
    var what = s.file.kind === "zip" ? "Архив · " + s.files + " " + plural(s.files, "файл", "файла", "файлов") + " · " + fmtSize(s.file.size) : s.file.name + " · " + fmtSize(s.file.size);
    return h("div", { class: "sk-file", title: s.file.name }, h("b", { class: s.file.kind, text: s.file.kind }), h("span", { text: what }));
  }

  function renderSkills() {
    if (!skEls) return;   // render() before this part of the file has run
    var on = state.lib === "skills";
    var loading = !state.loaded;
    els.views.prompts.classList.toggle("lib-skills", on);
    skEls.row.hidden = loading;
    skEls.seg.querySelectorAll("button[data-lib]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.lib === state.lib)); });
    skEls.nPrompts.textContent = state.items.length ? String(state.items.length) : "";
    skEls.nSkills.textContent = state.skills.length ? String(state.skills.length) : "";
    if (!on || loading) return;
    var total = state.skills.length;
    var counts = SKILL_TYPES.map(function (t) { return { t: t, n: state.skills.filter(function (s) { return s.type === t.key; }).length }; });
    els.meta.textContent = !total ? "Пока ни одного скилла" : fmtNum(total) + " " + plural(total, "скилл", "скилла", "скиллов") + counts.filter(function (c) { return c.n; }).map(function (c) { return " · " + c.t.label + " " + c.n; }).join("");
    if (sk.type !== "all" && !counts.some(function (c) { return c.t.key === sk.type && c.n; })) sk.type = "all";
    skEls.toolbar.hidden = !total;
    var chips = [h("button", { type: "button", class: "fchip", "aria-pressed": String(sk.type === "all"), onclick: function () { sk.type = "all"; render(); } },
      "Все", h("span", { class: "n", text: String(total) }))];
    counts.forEach(function (c) {
      if (!c.n) return;
      chips.push(h("button", { type: "button", class: "fchip " + c.t.cls, "aria-pressed": String(sk.type === c.t.key),
        onclick: function () { sk.type = sk.type === c.t.key ? "all" : c.t.key; render(); } },
        h("span", { class: "dot", "aria-hidden": "true" }), c.t.label, h("span", { class: "n", text: String(c.n) })));
    });
    skEls.filters.replaceChildren.apply(skEls.filters, chips);
    if (!total) {
      skEls.table.hidden = true;
      skEls.state.hidden = false;
      skEls.state.replaceChildren(
        h("div", { class: "dots", "aria-hidden": "true" }, SKILL_TYPES.map(function (t) { return h("i", { class: t.cls }); })),
        h("h2", { text: "Здесь будут ваши скиллы" }),
        h("p", { text: "Скилл — это инструкция для ассистента: файл .md или архив .zip. Добавьте его кнопкой или перетащите файл сюда — ассистент сам напишет, что это за скилл, и выберет тип. Так все скиллы хранятся в одном месте и не потеряются при переезде на другую модель или аккаунт." }),
        sk.draft ? null : h("button", { type: "button", class: "btn btn-primary", onclick: pickSkill }, "Добавить первый скилл"));
      return;
    }
    var list = state.skills.filter(skillMatches);
    if (!list.length) {
      skEls.table.hidden = true;
      skEls.state.hidden = false;
      skEls.state.replaceChildren(h("h2", { text: "Ничего не нашлось" }), h("p", { text: "Попробуйте другое слово или сбросьте фильтр по типу." }),
        h("button", { type: "button", class: "btn btn-ghost", onclick: function () { sk.type = "all"; sk.query = ""; skEls.search.value = ""; render(); skEls.search.focus(); } }, "Сбросить поиск"));
      return;
    }
    skEls.state.hidden = true;
    skEls.table.hidden = false;
    // While a row is being edited, its fields keep what is typed: the row is rebuilt from sk.edit.
    skEls.rows.replaceChildren.apply(skEls.rows, list.map(skillRow));
  }

  function skillRow(s) {
    var t = skillType(s.type);
    var actions;
    if (sk.confirmId === s.id) {
      actions = h("div", { class: "row-actions confirm" }, h("span", { text: "Удалить скилл?" }),
        h("button", { type: "button", class: "link-btn danger", onclick: function () { removeSkill(s.id); } }, "Удалить"),
        h("button", { type: "button", class: "link-btn", onclick: function () { sk.confirmId = null; render(); } }, "Отмена"));
    } else {
      actions = h("div", { class: "row-actions" },
        h("button", { type: "button", class: "btn-mini dl", title: "Сохранить исходный файл скилла — " + s.file.name, onclick: function () { downloadSkill(s); } }, icon("download"), h("span", { text: "Скачать" })),
        h("button", { type: "button", class: "btn-mini", "aria-expanded": String(sk.open.has(s.id)), title: "Список файлов и начало текста скилла",
          onclick: function () { if (sk.open.has(s.id)) sk.open.delete(s.id); else sk.open.add(s.id); render(); } },
          icon("chevron"), h("span", { text: sk.open.has(s.id) ? "Свернуть" : "Что внутри" })),
        h("button", { type: "button", class: "link-btn", onclick: function () { sk.confirmId = s.id; render(); } }, "Удалить"));
    }
    return h("tr", { "data-id": s.id, class: sk.open.has(s.id) ? "sk-open" : null },
      h("td", { class: "c-name" }, h("div", { class: "name", text: s.title || "Без названия" }),
        h("div", { class: "when", title: new Date(s.createdAt).toLocaleString("ru-RU") }, "Добавлен " + fmtWhen(s.createdAt)),
        skillFileLine(s), actions),
      h("td", { class: "c-type" }, t ? h("button", { type: "button", class: "chip " + t.cls, title: "Показать только «" + t.label + "»", onclick: function () { sk.type = t.key; render(); } }, t.label)
        : h("span", { class: "muted", text: sk.busy.has(s.id) ? "выбирает ассистент" : "—" })),
      h("td", { class: "c-prompt" }, sk.edit && sk.edit.id === s.id ? skillEditor(s) : skillDesc(s), sk.open.has(s.id) ? skillInside(s) : null));
  }

  function skillDesc(s) {
    if (sk.busy.has(s.id)) {
      var m = state.info && state.info.assistant && state.info.assistant.keys;
      var who = m && !m.openai && m.anthropic ? "Claude Haiku 5.5" : "GPT-6.1 Sol";
      return h("div", { class: "sk-writing" }, h("span", { text: who + " читает скилл, пишет описание и выбирает тип… обычно 10–30 секунд" }), h("div", { class: "bar" }, h("i")));
    }
    var err = sk.errors[s.id];
    if (err || !s.desc) {
      var kids = [h("span", { text: err ? err.error : "Описания пока нет." })];
      var acts = [];
      if (err && err.nokey) acts.push(h("button", { type: "button", class: "btn-mini dl", onclick: function () { openSettings("keys"); } }, h("span", { text: "Подключить ChatGPT или Claude" })));
      else acts.push(h("button", { type: "button", class: "btn-mini dl", onclick: function () { describeSkill(s.id); } }, icon("spark"), h("span", { text: err ? "Попробовать ещё раз" : "Написать с ассистентом" })));
      acts.push(h("button", { type: "button", class: "btn-mini", onclick: function () { startSkillEdit(s); } }, icon("pencil"), h("span", { text: "Написать самому" })));
      kids.push(h("div", { class: "acts" }, acts));
      return h("div", { class: "sk-nokey" }, kids);
    }
    var full = sk.more.has(s.id);
    var p = h("p", { class: "sk-desc" + (full ? "" : " is-collapsed"), title: full ? "" : "Нажмите, чтобы прочитать целиком", text: s.desc });
    p.addEventListener("click", function () {
      var sel = window.getSelection && window.getSelection();
      if (sel && String(sel).length) return;
      if (sk.more.has(s.id)) sk.more.delete(s.id); else sk.more.add(s.id);
      p.classList.toggle("is-collapsed", !sk.more.has(s.id));
    });
    var by = s.descBy && s.descBy !== "manual" ? modelLabel(s.descBy) + (s.descCost > 0 ? " · " + fmtCost(s.descCost) : "") + (s.descAt ? " · " + fmtWhen(s.descAt) : "") : "Описание написано вручную";
    return h("div", { class: "sk-descbox" }, p,
      h("div", { class: "sk-meta" },
        h("span", { class: "sk-who" }, icon(s.descBy && s.descBy !== "manual" ? "spark" : "pencil"), h("span", { text: by })),
        h("span", { class: "sk-acts" },
        h("button", { type: "button", class: "btn-mini", title: "Поправить название, тип и описание", onclick: function () { startSkillEdit(s); } }, icon("pencil"), h("span", { text: "Изменить" })),
        h("button", { type: "button", class: "btn-mini", title: "Попросить ассистента написать описание заново (тип останется)", onclick: function () { describeSkill(s.id, true); } }, icon("spark"), h("span", { text: "Пересоздать" })))));
  }

  // «Что внутри»: the files of an archive and the beginning of the main Markdown file, without downloading.
  function skillInside(s) {
    var kids = [];
    if (s.file.kind === "zip") {
      kids.push(h("span", { class: "cap", text: "Файлы в архиве" + (s.files > s.inside.length ? " (первые " + s.inside.length + " из " + s.files + ")" : "") }),
        h("ul", null, s.inside.slice(0, 60).map(function (f) {
          return h("li", { class: f.path === s.main ? "main" : null }, h("span", { text: f.path }), h("span", { text: fmtSize(f.size) }));
        })));
      if (s.inside.length > 60) kids.push(h("span", { class: "muted", text: "… и ещё " + (s.inside.length - 60) }));
    }
    if (s.text) kids.push(h("span", { class: "cap", text: "Начало " + (s.main ? s.main.split("/").pop() : s.file.name) }), h("pre", { text: s.text.slice(0, 1200) }));
    else kids.push(h("span", { class: "muted", text: "Текстового файла .md в архиве нет." }));
    return h("div", { class: "sk-inside" }, kids);
  }

  // A small type picker: "" — let the assistant choose (only for a new skill).
  function skillTypePicker(value, withAuto, onpick) {
    var name = "skt" + Math.random().toString(36).slice(2, 7);
    var opts = (withAuto ? [{ key: "", label: "Определит ассистент", cls: "cat-other" }] : []).concat(SKILL_TYPES);
    return h("div", { class: "cat-picker", role: "radiogroup", "aria-label": "Тип скилла" }, opts.map(function (t) {
      var inp = h("input", { type: "radio", name: name, value: t.key });
      inp.checked = value === t.key;
      inp.addEventListener("change", function () { if (inp.checked) onpick(t.key); });
      return h("label", { class: "cat-option " + t.cls + (t.key ? "" : " sk-auto-opt") }, inp, h("span", { text: t.label }));
    }));
  }
  function startSkillEdit(s) {
    sk.edit = { id: s.id, title: s.title, type: s.type, desc: s.desc };
    render();
    var f = skEls.rows.querySelector(".sk-edit textarea");
    if (f) f.focus();
  }
  function skillEditor(s) {
    var e = sk.edit;
    var title = h("input", { class: "input", type: "text", maxlength: "300", value: e.title, "aria-label": "Название скилла" });
    title.addEventListener("input", function () { e.title = title.value; });
    var desc = h("textarea", { class: "textarea prose", rows: "5", placeholder: "Что это за скилл, для чего он и как работает" });
    desc.value = e.desc;
    desc.addEventListener("input", function () { e.desc = desc.value; });
    var save = function () {
      call(api.skillSave({ id: s.id, title: e.title.trim() || s.title, type: e.type, desc: e.desc })).then(function (r) {
        if (!r) return;
        sk.edit = null;
        delete sk.errors[s.id];
        render();
        toast("Скилл сохранён");
      });
    };
    var box = h("div", { class: "sk-edit" },
      h("label", { class: "field-label", text: "Название" }), title,
      h("span", { class: "field-label", text: "Тип" }), skillTypePicker(e.type, false, function (k) { e.type = k; }),
      h("span", { class: "field-label", text: "Описание" }), desc,
      h("div", { class: "editor-actions" },
        h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: save }, "Сохранить"),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: function () { sk.edit = null; render(); } }, "Отмена"),
        h("span", { class: "hint", text: "Ctrl + Enter — сохранить, Esc — отмена" })));
    box.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); sk.edit = null; render(); }
    });
    return box;
  }

  /* adding: «Добавить скилл» or a dropped file opens the form with the title taken from the file */
  function pickSkill() {
    call(api.skillPick()).then(function (r) { if (r && !r.canceled) openSkillForm(r); });
  }
  function openSkillForm(info) {
    sk.draft = { path: info.path, name: info.name, size: info.size, kind: info.kind, files: info.files, main: info.main, title: info.title, auto: info.title, type: "", desc: "" };
    renderSkillForm();
    render();
    var f = skEls.formSlot.querySelector("input");
    if (f) { f.focus(); f.select(); }
  }
  function closeSkillForm() { sk.draft = null; renderSkillForm(); render(); }
  function renderSkillForm() {
    var d = sk.draft;
    if (!d) { skEls.formSlot.replaceChildren(); return; }
    var m = state.info && state.info.assistant && state.info.assistant.keys;
    var noKey = m && !m.openai && !m.anthropic;
    var who = m && !m.openai && m.anthropic ? "Claude Haiku 5.5" : "GPT-6.1 Sol";
    var title = h("input", { class: "input", id: "skf-title", type: "text", maxlength: "300", value: d.title, autocomplete: "off" });
    title.addEventListener("input", function () { d.title = title.value; });
    var desc = h("textarea", { class: "textarea prose", id: "skf-desc", rows: "4",
      placeholder: noKey ? "Опишите сами: что это за скилл, для чего он и как работает. Чтобы описание писалось само, подключите ChatGPT или Claude в «Настройках»."
        : "Оставьте пустым — " + who + " прочитает скилл и напишет 5–6 предложений: что это, для чего он и как работает." });
    desc.addEventListener("input", function () { d.desc = desc.value; });
    var fromWhat = d.title === d.auto ? (d.main || d.kind === "md" ? "Подставлено из файла — можно поменять" : "Подставлено из названия архива — можно поменять") : "";
    var msg = h("span", { class: "form-msg", role: "status" });
    var save = h("button", { type: "submit", class: "btn btn-primary" }, "Сохранить");
    var form = h("form", { class: "editor inline sk-form", novalidate: "novalidate" },
      h("h2", { text: "Новый скилл" }),
      h("div", { class: "fields" },
        h("div", { class: "field" }, h("label", { class: "field-label", for: "skf-title", text: "Название" }), title, fromWhat ? h("span", { class: "from-file", text: fromWhat }) : null),
        h("div", { class: "field" }, h("span", { class: "field-label", text: "Тип" }), skillTypePicker(d.type, !noKey, function (k) { d.type = k; })),
        h("div", { class: "field full" }, h("span", { class: "field-label", text: "Файл скилла" }),
          h("div", { class: "sk-picked" }, h("span", { class: "tile doc" }, h("span", { class: "ext", text: d.kind })),
            h("div", null, h("div", { class: "t", text: d.name }),
              h("div", { class: "s", text: (d.kind === "zip" ? "Архив · " + d.files + " " + plural(d.files, "файл", "файла", "файлов") + " · " : "") + fmtSize(d.size) + (d.main ? " · главный файл " + d.main : "") })),
            h("span", { class: "spacer" }),
            h("button", { type: "button", class: "btn-mini", onclick: pickSkill }, "Выбрать другой…"))),
        h("div", { class: "field full" }, h("label", { class: "field-label", for: "skf-desc", text: "Описание" }),
          noKey ? null : h("div", { class: "sk-auto" }, h("span", { class: "pill" }, icon("spark"), who + " · Средне"),
            h("span", { text: "напишет описание после сохранения" + (d.type ? "" : " и выберет тип") + " — или впишите сами" })),
          desc)),
      h("div", { class: "editor-actions" }, save,
        h("button", { type: "button", class: "btn btn-ghost", onclick: closeSkillForm }, "Отмена"),
        h("span", { class: "hint", text: "Ctrl + Enter — сохранить, Esc — отмена" }), msg));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (save.disabled) return;
      if (!d.title.trim()) { msg.textContent = "Напишите название"; title.focus(); return; }
      save.disabled = true;
      call(api.skillAdd({ path: d.path, title: d.title.trim(), type: d.type, desc: d.desc.trim() })).then(function (r) {
        save.disabled = false;
        if (!r) return;
        var chose = !!d.type;
        var wrote = !!d.desc.trim();
        sk.draft = null;
        renderSkillForm();
        sk.type = "all";
        render();
        toast("Скилл «" + d.title.trim() + "» сохранён");
        if (!wrote && !noKey) describeSkill(r.skillId, chose);
      });
    });
    form.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSkillForm(); }
    });
    skEls.formSlot.replaceChildren(form);
  }
  // Several files dropped at once: each is added straight away; the assistant writes the descriptions and picks the types.
  function addSkillFiles(paths) {
    var m = state.info && state.info.assistant && state.info.assistant.keys;
    var noKey = m && !m.openai && !m.anthropic;
    paths.reduce(function (p, file) {
      return p.then(function () { return api.skillInspect(file); }).then(function (info) {
        if (!info || !info.ok) { toast((info && info.error) || "Файл не открылся", true); return; }
        return call(api.skillAdd({ path: info.path, title: info.title, type: "", desc: "" })).then(function (r) {
          if (!r) return;
          render();
          if (!noKey) describeSkill(r.skillId, false);
        });
      });
    }, Promise.resolve()).then(function () { toast("Скиллы добавлены"); });
  }

  // keepType: «Пересоздать» or a type the user chose keeps the type; otherwise the assistant puts its own.
  function describeSkill(id, keepType) {
    if (sk.busy.has(id)) return;
    sk.busy.add(id);
    delete sk.errors[id];
    render();
    api.skillDescribe(id, !!keepType).then(function (r) {
      sk.busy.delete(id);
      if (r && r.ok) applyData(r);
      else sk.errors[id] = { error: (r && r.error) || "Описание не получилось. Попробуйте ещё раз.", nokey: !!(r && r.nokey) };
      render();
    }, function () {
      sk.busy.delete(id);
      sk.errors[id] = { error: "Описание не получилось. Попробуйте ещё раз." };
      render();
    });
  }
  function downloadSkill(s) {
    call(api.skillDownload(s.id)).then(function (r) {
      if (!r || r.canceled) return;
      undoToast("Скилл сохранён: " + r.path, function () { api.skillReveal(s.id); }, "Показать в папке");
    });
  }
  function removeSkill(id) {
    sk.confirmId = null;
    call(api.skillDelete(id)).then(function (r) { if (r) { render(); toast("Скилл удалён, его файл — в корзине Windows"); } });
  }
  skEls.add.addEventListener("click", pickSkill);
  skEls.search.addEventListener("input", function () { sk.query = skEls.search.value; render(); });

  /* ---------- search and filters ---------- */
  function taskVisible(t, inArchive) {
    if (tf.hideDone && t.status === "done" && !inArchive) return false;
    if (tf.tag && (t.tags || []).indexOf(tf.tag) === -1) return false;
    if (tf.prio && t.priority < tf.prio) return false;
    if (!tf.q) return true;
    var q = norm(tf.q);
    return norm(t.title).indexOf(q) !== -1 || norm(t.note).indexOf(q) !== -1 ||
      (t.tags || []).some(function (g) { return norm(g).indexOf(q) !== -1; }) ||
      (t.subtasks || []).some(function (s) { return norm(s.title).indexOf(q) !== -1; });
  }
  function renderTaskFilters() {
    els.tview.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === tf.view)); });
    var tags = [];
    state.tasks.forEach(function (t) { (t.tags || []).forEach(function (g) { if (tags.indexOf(g) === -1) tags.push(g); }); });
    tags.sort(function (a, b) { return a.localeCompare(b, "ru"); });
    if (tf.tag && tags.indexOf(tf.tag) === -1) tags.unshift(tf.tag);
    var key = tags.join("\n");
    if (els.tfTag.dataset.key !== key) {
      els.tfTag.dataset.key = key;
      els.tfTag.replaceChildren.apply(els.tfTag, [h("option", { value: "" }, "Все теги")].concat(tags.map(function (g) { return h("option", { value: g }, g); })));
    }
    els.tfTag.value = tf.tag;
    els.tfTag.disabled = !tags.length;
    els.tfPrio.value = String(tf.prio);
    els.tfDone.setAttribute("aria-pressed", String(tf.hideDone));
    els.tfDone.hidden = tf.view === "archive";
    els.tfReset.hidden = !(tf.q || tf.tag || tf.prio);
  }
  els.tview.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-v]");
    if (b) setTaskView(b.dataset.v);
  });
  els.tsearch.addEventListener("input", function () { tf.q = els.tsearch.value.trim(); renderTasks(); });
  els.tsearch.addEventListener("keydown", function (e) { if (e.key === "Escape" && els.tsearch.value) { e.stopPropagation(); els.tsearch.value = ""; tf.q = ""; renderTasks(); } });
  els.tfTag.addEventListener("change", function () { tf.tag = els.tfTag.value; renderTasks(); });
  els.tfPrio.addEventListener("change", function () { tf.prio = Number(els.tfPrio.value) || 0; renderTasks(); });
  els.tfDone.addEventListener("click", function () {
    tf.hideDone = !tf.hideDone;
    try { localStorage.setItem("tasksHideDone", tf.hideDone ? "1" : "0"); } catch (err) {}
    renderTasks();
  });
  els.tfReset.addEventListener("click", function () { tf.q = ""; tf.tag = ""; tf.prio = 0; els.tsearch.value = ""; renderTasks(); });

  /* ---------- the user's own columns ---------- */
  // The three base columns always stay (a lock in the header). The user's own sit before «Готово»; their «⋯» menu
  // renames, moves and deletes them. When a column is deleted its tasks go to «Предстоит», and «Отменить» brings it all back.
  function columnHead(c, ci, count) {
    if (tb.renaming === c.id) {
      var inp = h("input", { type: "text", class: "tcol-in", value: c.name, maxlength: "40", "aria-label": "Название столбца" });
      var done = false;
      var finish = function (save) {
        if (done) return;
        done = true;
        tb.renaming = null;
        var v = inp.value.trim();
        if (save && v && v !== c.name) call(api.columnRename(c.id, v)).then(function () { render(); }); else renderTasks();
      };
      inp.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      inp.addEventListener("blur", function () { finish(true); });
      return h("div", { class: "tcol-h" }, inp);
    }
    var cols = taskCols(), custom = cols.filter(function (x) { return !x.base; }), at = custom.indexOf(c);
    var side;
    var item = function (iconName, label, fn, cls) {
      return h("button", { type: "button", role: "menuitem", class: cls || "", onclick: function (e) { e.stopPropagation(); tb.colMenu = null; fn(); } }, icon(iconName), label);
    };
    if (c.id === "done") {
      var doneLeft = (state.tasks || []).filter(function (t) { return t.status === "done" && !t.archivedAt; }).length;
      side = h("div", { class: "tcol-menu" },
        h("button", { type: "button", class: "tcol-more", html: ICONS.dots, title: "Архив выполненных задач", "aria-label": "Архив выполненных задач",
          "aria-haspopup": "true", "aria-expanded": String(tb.colMenu === c.id),
          onclick: function (e) { e.stopPropagation(); tb.colMenu = tb.colMenu === c.id ? null : c.id; renderTasks(); } }),
        tb.colMenu === c.id ? h("div", { class: "tcol-pop", role: "menu" },
          doneLeft ? item("archive", "Убрать в архив сейчас (" + doneLeft + ")", function () { archiveNow(); }) : null,
          item("archive", "Открыть архив", function () { setTaskView("archive"); }),
          h("p", { class: "tcol-pop-h", text: "Убирать в архив само" }),
          ARCHIVE_MODES.map(function (m) {
            var on = state.taskArchiveMode === m.id;
            return h("button", { type: "button", role: "menuitemradio", "aria-checked": String(on), class: on ? "on" : "", title: m.hint,
              onclick: function (e) { e.stopPropagation(); tb.colMenu = null; setArchiveMode(m.id); } },
              h("span", { class: "ico", html: on ? ICONS.check : "", "aria-hidden": "true" }), h("span", null, m.name, h("small", { text: m.hint })));
          })) : null);
    } else if (c.base) side = h("span", { class: "tcol-lock", html: ICONS.lock, title: "Основной столбец: его нельзя удалить или переименовать" });
    else {
      side = h("div", { class: "tcol-menu" },
        h("button", { type: "button", class: "tcol-more", html: ICONS.dots, title: "Действия со столбцом", "aria-label": "Действия со столбцом «" + c.name + "»",
          "aria-haspopup": "true", "aria-expanded": String(tb.colMenu === c.id),
          onclick: function (e) { e.stopPropagation(); tb.colMenu = tb.colMenu === c.id ? null : c.id; renderTasks(); } }),
        tb.colMenu === c.id ? h("div", { class: "tcol-pop", role: "menu" },
          item("pencil", "Переименовать", function () { tb.renaming = c.id; renderTasks(); }),
          at > 0 ? item("left", "Сдвинуть левее", function () { call(api.columnMove(c.id, -1)).then(function () { render(); }); }) : null,
          at < custom.length - 1 ? item("right", "Сдвинуть правее", function () { call(api.columnMove(c.id, 1)).then(function () { render(); }); }) : null,
          item("trash", "Удалить столбец", function () { removeColumn(c); }, "danger")) : null);
    }
    return h("div", { class: "tcol-h" }, h("span", { class: "tcol-name" }, h("i", { "aria-hidden": "true" }), c.name), h("span", { class: "tcol-n", text: String(count) }), side);
  }
  /* ---------- the archive of done tasks ---------- */
  // Done tasks leave the board: by «Убрать в архив» at the bottom of «Готово», by the assistant, or by themselves
  // (main.js, state.taskArchiveMode). In the «Архив» view they are grouped by the day they were done; a click opens
  // the panel with «Вернуть на доску»; taking the tick off sends a task back to work.
  var ARCHIVE_MODES = [
    { id: "day", name: "Каждый день", hint: "утром — всё, что сделано до сегодняшнего дня" },
    { id: "week", name: "Через неделю", hint: "то, что сделано больше 7 дней назад" },
    { id: "manual", name: "Только вручную", hint: "кнопкой «Убрать в архив»" }
  ];
  function setTaskView(v) {
    if (tf.view === v) return;
    tf.view = v;
    try { localStorage.setItem("tasksView", v); } catch (err) {}
    renderTasks();
  }
  function archiveRow(n) {
    if (!n) return null;
    var mode = ARCHIVE_MODES.find(function (m) { return m.id === state.taskArchiveMode; }) || ARCHIVE_MODES[0];
    return h("button", { type: "button", class: "task-add tarch-btn", title: "Выполненные уйдут в «Архив» (кнопка рядом с «Доска / Список»). Само убирается: " + mode.name.toLowerCase() + " — " + mode.hint,
      onclick: function () { archiveNow(); } }, icon("archive"), "Убрать в архив (" + n + ")");
  }
  function archiveNow() {
    call(api.tasksArchive(null)).then(function (r) {
      if (!r) return;
      render();
      var ids = r.archived || [];
      if (!ids.length) return;
      undoToast(ids.length + " " + plural(ids.length, "задача убрана", "задачи убраны", "задач убрано") + " в архив", function () {
        call(api.tasksUnarchive(ids)).then(function (x) { if (x) render(); });
      });
    });
  }
  function setArchiveMode(mode) {
    call(api.tasksArchiveMode(mode)).then(function (r) {
      if (!r) return;
      render();
      var n = (r.archived || []).length;
      var m = ARCHIVE_MODES.find(function (x) { return x.id === mode; });
      toast(m.name + (mode === "manual" ? ": сами задачи больше не уберутся" : ": " + m.hint) + (n ? ". Убрано в архив: " + n : ""), true);
    });
  }
  api.onTasksArchived(function (n) {
    if (state.page === "tasks") toast("Выполненные задачи убраны в архив: " + n + ". Они в «Архиве» рядом с «Доска / Список».", true);
  });
  // By the day a task was done: today, yesterday, the last 7 days, then by month, newest first.
  function archiveGroup(t) {
    var d = new Date(t.doneAt || t.updatedAt), now = new Date();
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (d.getTime() >= start) return "Сегодня";
    if (d.getTime() >= start - 864e5) return "Вчера";
    if (d.getTime() >= start - 6 * 864e5) return "На этой неделе";
    return MONTHS_NOM[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "");
  }
  function renderTaskArchive(shown) {
    var mode = ARCHIVE_MODES.find(function (m) { return m.id === state.taskArchiveMode; }) || ARCHIVE_MODES[0];
    var kids = [h("p", { class: "tarch-info" }, icon("archive"),
      h("span", { text: "Сюда уходят выполненные задачи: кнопкой «Убрать в архив» внизу столбца «Готово» или сами — " + mode.name.toLowerCase() +
        (mode.id === "manual" ? "" : " (" + mode.hint + ")") + ". Поменять — в меню «⋯» у «Готово». Нажмите на задачу, чтобы открыть её или вернуть на доску." }))];
    var groups = [];
    shown.slice().sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); }).forEach(function (t) {
      var g = archiveGroup(t), last = groups[groups.length - 1];
      if (!last || last.name !== g) groups.push(last = { name: g, items: [] });
      last.items.push(t);
    });
    groups.forEach(function (g) {
      kids.push(h("section", { class: "tgroup" }, h("h3", { class: "tgroup-h" }, g.name, h("span", { text: String(g.items.length) })), g.items.map(function (t) { return taskRow(t, true); })));
    });
    if (!shown.length) kids.push(h("p", { class: "tlist-empty", text: tf.q || tf.tag || tf.prio ? "В архиве под фильтр ничего не подходит." : "Архив пока пуст." }));
    els.tlist.replaceChildren.apply(els.tlist, kids);
  }

  function removeColumn(c) {
    call(api.columnDelete(c.id)).then(function (r) {
      if (!r) return;
      render();
      var gone = r.removed;
      if (!gone) return;
      undoToast("Столбец «" + c.name + "» удалён" + (gone.moved.length ? ", задачи переехали в «Предстоит»" : ""), function () {
        call(api.columnRestore(gone)).then(function (x) { if (x) render(); });
      });
    });
  }
  // «+ Столбец» after the last column; while open, a field for the name (Enter — add, Esc — close).
  function newColumnBox() {
    if (!tb.newCol) {
      return h("button", { type: "button", class: "tcol-add", title: "Свой столбец встанет перед «Готово»", onclick: function () { tb.newCol = true; renderTasks(); var x = els.board.querySelector(".tcol-new input"); if (x) x.focus(); } },
        icon("plus"), "Столбец");
    }
    var inp = h("input", { type: "text", class: "tcol-in", maxlength: "40", placeholder: "Название столбца", "aria-label": "Название нового столбца" });
    var done = false;
    var finish = function (save) {
      if (done) return;
      done = true;
      tb.newCol = false;
      var v = inp.value.trim();
      if (save && v) call(api.columnAdd(v)).then(function () { render(); }); else renderTasks();
    };
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    inp.addEventListener("blur", function () { finish(true); });
    return h("section", { class: "tcol tcol-new tcc-" + ((state.taskColumns || []).filter(function (x) { return !x.base; }).length % 6) }, inp,
      h("p", { class: "tcol-empty", text: "Enter — добавить, Esc — передумать" }));
  }
  document.addEventListener("mousedown", function (e) {
    if (tb.colMenu && !e.target.closest(".tcol-menu")) { tb.colMenu = null; renderTasks(); }
  });

  /* ---------- the «Список» view ---------- */
  // Open tasks by due day: overdue, today, tomorrow, the next 7 days, later, no due day; done ones folded at the bottom.
  var LIST_GROUPS = [
    { name: "Срок прошёл", late: true, test: function (n) { return n !== null && n < 0; } },
    { name: "Сегодня", test: function (n) { return n === 0; } },
    { name: "Завтра", test: function (n) { return n === 1; } },
    { name: "В ближайшие 7 дней", test: function (n) { return n !== null && n > 1 && n <= 7; } },
    { name: "Позже", test: function (n) { return n !== null && n > 7; } },
    { name: "Без срока", test: function (n) { return n === null; } }
  ];
  function daysUntil(t) {
    if (!t.due) return null;
    var now = new Date();
    return Math.round((new Date(t.due + "T00:00") - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
  }
  function taskRow(t, inArchive) {
    var d = t.due && !inArchive ? dueInfo(t) : null;
    var cls = "trow " + colClass(t.status) + (t.status === "done" ? " is-done" : "") + (tb.open === t.id ? " sel" : "") + (tb.fresh.indexOf(t.id) !== -1 ? " fresh" : "");
    var el = h("div", { class: cls, tabindex: "0", "data-id": t.id, onclick: function () { openTask(t.id); },
      onkeydown: function (e) { if (e.key === "Enter" && e.target === el) openTask(t.id); } },
      taskCheck(t),
      h("div", { class: "trow-main" }, h("span", { class: "task-t", text: t.title }), taskMarks(t, true)),
      h("div", { class: "trow-side" },
        d ? h("span", { class: "tmark due" + (d.late ? " late" : d.today ? " today" : "") }, icon("calendar"), d.text) : null,
        inArchive ? h("span", { class: "trow-col trow-when", title: "Поставлена " + fmtStamp(t.createdAt) + (t.startedAt ? "\nНачата " + fmtStamp(t.startedAt) : "") + "\nСделана " + fmtStamp(t.doneAt) }, "сделана " + fmtDay(new Date(t.doneAt)))
          : h("span", { class: "trow-col" }, h("i", { "aria-hidden": "true" }), colName(t.status))));
    return el;
  }
  function renderTaskList(shown) {
    var open = shown.filter(function (t) { return t.status !== "done"; });
    var done = shown.filter(function (t) { return t.status === "done"; });
    var kids = [];
    LIST_GROUPS.forEach(function (g) {
      var items = open.filter(function (t) { return g.test(daysUntil(t)); }).sort(function (a, b) {
        return (a.due || "").localeCompare(b.due || "") || (a.time || "99").localeCompare(b.time || "99") || b.priority - a.priority || a.order - b.order;
      });
      if (!items.length) return;
      kids.push(h("section", { class: "tgroup" }, h("h3", { class: "tgroup-h" + (g.late ? " late" : "") }, g.name, h("span", { text: String(items.length) })), items.map(taskRow)));
    });
    if (!open.length) {
      kids.push(h("p", { class: "tlist-empty", text: tf.q || tf.tag || tf.prio ? "Под фильтр ничего не подходит." :
        state.tasks.length ? "Все задачи сделаны." : "Пока задач нет. Напишите ассистенту сверху или добавьте задачу в виде «Доска»." }));
    }
    if (done.length) {
      kids.push(h("section", { class: "tgroup" },
        h("h3", { class: "tgroup-h" }, h("button", { type: "button", class: "tgroup-fold", "aria-expanded": String(tf.doneOpen), onclick: function () { tf.doneOpen = !tf.doneOpen; renderTasks(); } },
          h("span", { class: "ico" + (tf.doneOpen ? " open" : ""), html: ICONS.right, "aria-hidden": "true" }), "Готово", h("span", { text: String(done.length) }))),
        tf.doneOpen ? done.map(taskRow) : null));
    }
    els.tlist.replaceChildren.apply(els.tlist, kids);
  }

  /* The timeline of a task: set → started → done → in the archive, with how long each step took and the whole way. */
  // Exact time: "40 минут", "1 час 10 минут", "2 дня 3 часа" (at most two units, rounded to the minute)
  function fmtSpan(ms) {
    var mins = Math.round(ms / 60e3);
    if (mins < 1) return "меньше минуты";
    var days = Math.floor(mins / 1440), hrs = Math.floor(mins % 1440 / 60), m = mins % 60, parts = [];
    if (days) parts.push(days + " " + plural(days, "день", "дня", "дней"));
    if (hrs) parts.push(hrs + " " + plural(hrs, "час", "часа", "часов"));
    if (m && !days) parts.push(m + " " + plural(m, "минута", "минуты", "минут"));
    return parts.join(" ");
  }
  function fmtStamp(ms) {
    var d = new Date(ms), now = new Date(), time = d.getHours() + ":" + pad2(d.getMinutes());
    if (dayKey(d) === dayKey(now)) return "сегодня, " + time;
    if (dayKey(d) === dayKey(addDays(now, -1))) return "вчера, " + time;
    return fmtDay(d, d.getFullYear() !== now.getFullYear()) + ", " + time;
  }
  function taskTimeline(t) {
    var steps = [{ name: "Поставлена", at: t.createdAt }];
    if (t.startedAt) steps.push({ name: "Начата", at: t.startedAt });
    if (t.status === "done" && t.doneAt) steps.push({ name: "Сделана", at: t.doneAt, done: true });
    if (t.archivedAt) steps.push({ name: "В архиве", at: t.archivedAt });
    var rows = steps.map(function (s, i) {
      var prev = steps[i - 1];
      return h("li", { class: "tl-step" + (s.done ? " done" : "") }, h("i", { "aria-hidden": "true" }),
        h("span", { class: "tl-name", text: s.name }),
        h("span", { class: "tl-at", title: new Date(s.at).toLocaleString("ru-RU"), text: fmtStamp(s.at) }),
        prev && s.at >= prev.at ? h("span", { class: "tl-gap", text: "через " + fmtSpan(s.at - prev.at) }) : null);
    });
    var total = null;
    if (t.status === "done" && t.doneAt) total = "От постановки до готовности — " + fmtSpan(Math.max(0, t.doneAt - t.createdAt)) + (t.startedAt && t.doneAt >= t.startedAt ? ", в работе — " + fmtSpan(t.doneAt - t.startedAt) : "");
    else if (t.startedAt) total = "В работе уже " + fmtSpan(Math.max(0, Date.now() - t.startedAt));
    else total = "Ещё не начата: ждёт " + fmtSpan(Math.max(0, Date.now() - t.createdAt));
    return h("div", { class: "tp-block" }, h("div", { class: "tp-block-h" }, "Хронология"), h("ol", { class: "tl" }, rows), h("p", { class: "tl-total", text: total }));
  }

  /* The whole task: a panel on the right over the board, like in Notion. Every change is saved at once.
     A re-render while the user types in a field of the panel is skipped (force: our own save asked for it). */
  // Once a minute the "в работе уже …" / "ждёт …" line of an open task moves on by itself (only the timeline is redrawn)
  setInterval(function () {
    var p = els.tpanel, t = tb.open && state.page === "tasks" && !p.hidden ? findTask(tb.open) : null;
    var old = t && t.status !== "done" ? p.querySelector(".tl-total") : null;
    if (old) old.parentNode.replaceWith(taskTimeline(t));
  }, 60 * 1000);
  function openTask(id) { tb.open = id; renderTasks(); renderTaskPanel(true); }
  function closeTask() {
    var a = document.activeElement;
    if (a && els.tpanel.contains(a)) a.blur();   // the field being typed in saves itself on blur
    tb.open = null;
    renderTaskPanel(true);
    if (state.page === "tasks") renderTasks();
  }
  function savePanel(id, fields) {
    return call(api.taskSave(Object.assign({ id: id }, fields))).then(function (r) { render(); renderTaskPanel(true); return r; });
  }
  function renderTaskPanel(force) {
    var p = els.tpanel, t = tb.open && state.page === "tasks" ? findTask(tb.open) : null;
    if (!t) {
      if (tb.open && !findTask(tb.open)) tb.open = null;
      p.hidden = true;
      p.replaceChildren();
      return;
    }
    var a = document.activeElement;
    if (!force && !p.hidden && p.dataset.id === t.id && a && p.contains(a) && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type === "text"))) return;
    p.dataset.id = t.id;
    p.hidden = false;

    var title = h("textarea", { class: "tp-title", rows: "1", maxlength: "300", "aria-label": "Название задачи" });
    title.value = t.title;
    var fit = function () { title.style.height = "auto"; title.style.height = title.scrollHeight + "px"; };
    title.addEventListener("input", fit);
    title.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); title.blur(); } });
    title.addEventListener("change", function () {
      var v = title.value.trim();
      if (v && v !== t.title) savePanel(t.id, { title: v }); else title.value = t.title;
    });

    var status = h("select", { class: "tp-select", "aria-label": "Столбец", onchange: function () { savePanel(t.id, { status: this.value }); } },
      taskCols().map(function (c) { return h("option", { value: c.id, selected: c.id === t.status }, c.name); }));

    var today = new Date(), dayOf = function (n) { return dayKey(addDays(today, n)); };
    var quick = function (label, due) {
      return h("button", { type: "button", class: "tp-opt" + (t.due === due ? " on" : ""), onclick: function () { savePanel(t.id, due ? { due: due } : { due: "", time: "" }); } }, label);
    };
    var date = h("input", { type: "date", class: "tp-date", value: t.due, "aria-label": "Срок", onchange: function () { savePanel(t.id, { due: this.value }); } });
    var time = h("input", { type: "time", class: "tp-date", value: t.time, disabled: !t.due, title: t.due ? "Время — по желанию" : "Сначала выберите день", "aria-label": "Время",
      onchange: function () { savePanel(t.id, { time: this.value }); } });

    var tagIn = h("input", { type: "text", class: "tp-tag-in", placeholder: "+ тег", maxlength: "30", list: "tp-tag-list", "aria-label": "Новый тег" });
    // A tag is added by Enter, by picking it from the list (that only fills the field, without Enter) or by leaving
    // the field with something typed in it. The same tag twice (in any letter case) is not added.
    var addTag = function () {
      var v = tagIn.value.trim();
      tagIn.value = "";
      if (!v) return;
      v = v.charAt(0).toUpperCase() + v.slice(1);
      if (t.tags.some(function (g) { return g.toLowerCase() === v.toLowerCase(); })) return;
      savePanel(t.id, { tags: t.tags.concat([v]) });
    };
    tagIn.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addTag(); } });
    tagIn.addEventListener("input", function (e) {
      // Picked from the list: the browser puts the whole word in at once and says it is not typing.
      if (!e.inputType || e.inputType === "insertReplacementText") addTag();
    });
    tagIn.addEventListener("change", addTag);
    var known = TASK_TAGS.slice();
    state.tasks.forEach(function (x) { x.tags.forEach(function (g) { if (known.indexOf(g) === -1) known.push(g); }); });

    var subs = t.subtasks || [], subsDone = subs.filter(function (s) { return s.done; }).length;
    var subIn = h("input", { type: "text", class: "tp-sub-in", placeholder: "+ Подзадача (Enter — добавить)", maxlength: "300", "aria-label": "Новая подзадача" });
    subIn.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      var v = subIn.value.trim();
      if (!v) return;
      tb.focusSub = true;
      savePanel(t.id, { subtasks: subs.concat([{ title: v }]) });
    });

    var note = h("textarea", { class: "textarea tp-note", rows: "4", maxlength: "5000", placeholder: "Подробности, ссылки, мысли…", "aria-label": "Заметка" });
    note.value = t.note;
    note.addEventListener("change", function () { if (note.value.trim() !== t.note) savePanel(t.id, { note: note.value }); });

    var edited = t.updatedAt - t.createdAt > 60 * 1000;
    p.replaceChildren(
      h("div", { class: "tp-head" },
        h("span", { class: "tp-col " + colClass(t.status) }, h("i", { "aria-hidden": "true" }), colName(t.status)),
        h("button", { type: "button", class: "tp-close", html: ICONS.x, title: "Закрыть (Esc)", "aria-label": "Закрыть задачу", onclick: closeTask })),
      h("div", { class: "tp-body" },
        h("div", { class: "tp-title-row" }, taskCheck(t, true), title),
        h("div", { class: "tp-field" }, h("span", { class: "tp-label", text: "Столбец" }), status),
        h("div", { class: "tp-field" }, h("span", { class: "tp-label", text: "Срок" }),
          h("div", { class: "tp-opts" }, quick("Сегодня", dayOf(0)), quick("Завтра", dayOf(1)), quick("Без срока", ""), date, time)),
        h("div", { class: "tp-field" }, h("span", { class: "tp-label", text: "Важность" }),
          h("div", { class: "tp-opts" }, PRIORITIES.map(function (name, i) {
            return h("button", { type: "button", class: "tp-opt p" + i + (t.priority === i ? " on" : ""), "aria-pressed": t.priority === i ? "true" : "false",
              onclick: function () { savePanel(t.id, { priority: i }); } }, name);
          }))),
        h("div", { class: "tp-field" }, h("span", { class: "tp-label", text: "Теги" }),
          h("div", { class: "tp-opts" }, t.tags.map(function (g, i) {
            return h("span", { class: "tp-tag " + tagClass(g) }, g,
              h("button", { type: "button", html: ICONS.x, title: "Убрать тег", "aria-label": "Убрать тег «" + g + "»",
                onclick: function () { savePanel(t.id, { tags: t.tags.filter(function (x, j) { return j !== i; }) }); } }));
          }), tagIn, h("datalist", { id: "tp-tag-list" }, known.filter(function (g) { return t.tags.indexOf(g) === -1; }).map(function (g) { return h("option", { value: g }); })))),
        h("div", { class: "tp-block" },
          h("div", { class: "tp-block-h" }, "Подзадачи", subs.length ? h("span", { class: "tmark" }, taskBar(subsDone, subs.length), subsDone + " из " + subs.length) : null),
          h("div", { class: "tp-subs" }, subs.map(function (s) {
            return h("div", { class: "tp-sub" + (s.done ? " done" : "") },
              h("button", { type: "button", class: "tchk sq" + (s.done ? " on" : ""), html: ICONS.check, "aria-pressed": s.done ? "true" : "false",
                "aria-label": (s.done ? "Снять отметку: " : "Отметить: ") + s.title,
                onclick: function () { savePanel(t.id, { subtasks: subs.map(function (x) { return x.id === s.id ? Object.assign({}, x, { done: !x.done }) : x; }) }); } }),
              h("span", { text: s.title }),
              h("button", { type: "button", class: "tp-sub-del", html: ICONS.x, title: "Удалить подзадачу", "aria-label": "Удалить подзадачу «" + s.title + "»",
                onclick: function () { savePanel(t.id, { subtasks: subs.filter(function (x) { return x.id !== s.id; }) }); } }));
          })), subIn),
        h("div", { class: "tp-block" }, h("div", { class: "tp-block-h" }, "Заметка"), note),
        taskTimeline(t)),
      h("div", { class: "tp-foot" },
        h("span", { class: "tp-when", title: new Date(t.updatedAt).toLocaleString("ru-RU") }, edited ? "Изменена " + fmtWhen(t.updatedAt) : ""),
        t.archivedAt ? h("button", { type: "button", class: "btn-mini", title: "Задача вернётся в «Готово» на доске", onclick: function () { savePanel(t.id, { archivedAt: 0 }); } }, icon("left"), h("span", { class: "lbl", text: "Вернуть на доску" })) : null,
        h("button", { type: "button", class: "btn-mini tp-del", onclick: function () { removeTask(t); } }, icon("trash"), h("span", { class: "lbl", text: "Удалить" }))));
    fit();
    if (tb.focusSub) { tb.focusSub = false; var si = p.querySelector(".tp-sub-in"); if (si) si.focus(); }
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !els.tpanel.hidden && !document.querySelector("dialog[open]") && els.qa.hidden) { e.preventDefault(); closeTask(); }
  });
  // A click anywhere in the work area closes the panel too. Not a click on another task (that opens it instead),
  // on the panel itself, on notifications, menus, dialogs or the small assistant window.
  document.addEventListener("mousedown", function (e) {
    if (els.tpanel.hidden || e.button !== 0) return;
    var keep = ".tpanel, .task, .trow, .utoast, .tnotes, .toast, .menu, .tcol-pop, dialog, #qa, .qa-btn";
    if (e.target.closest && e.target.closest(keep)) return;
    closeTask();
  });

  // Deleting happens at once; for 7 seconds «Отменить» at the bottom brings the task back exactly as it was.
  var undoTimer = null;
  // label: the button's text when it is not «Отменить» (for example «Показать в папке»).
  function undoToast(text, undo, label) {
    els.utoastText.textContent = text;
    els.utoastUndo.textContent = label || "Отменить";
    els.utoastUndo.onclick = function () { els.utoast.hidden = true; clearTimeout(undoTimer); undo(); };
    els.utoast.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(function () { els.utoast.hidden = true; }, 7000);
  }
  function removeTask(t) {
    var copy = JSON.parse(JSON.stringify(t));
    if (tb.open === t.id) tb.open = null;
    state.tasks = state.tasks.filter(function (x) { return x.id !== t.id; });
    render();
    call(api.taskDelete(t.id)).then(function () { render(); });
    undoToast("Задача «" + t.title + "» удалена", function () { call(api.taskRestore(copy)).then(function (r) { if (r) render(); }); });
  }

  /* The tasks assistant bar: its own assistant that only knows tasks (the cheapest model, quick thinking).
     Every message is a separate request; changes apply at once. Enter sends, Ctrl + Enter (or Shift + Enter) starts a new line.
     The answer comes as a notification in the bottom right corner (taskNote) with «Отменить», which takes back what it changed. */
  var tbar = { busy: false };
  function growTbar() {
    var t = els.tbarInput;
    if (!t.value) { t.style.height = ""; return; }   // empty: one line (the long hint would count as two)
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 150) + "px";
  }
  function renderTbar() {
    els.tbarModel.textContent = quickModelName();
    els.tbar.classList.toggle("busy", tbar.busy);
    els.tbarInput.disabled = tbar.busy;
    els.tbarSend.disabled = tbar.busy || !els.tbarInput.value.trim();
    els.tbarSend.title = tbar.busy ? "Ассистент разбирает…" : "Отправить (Enter)";
  }
  function sendTbar(text) {
    var v = String(text || "").trim();
    if (!v || tbar.busy) return;
    tbar.busy = true;
    els.tbarInput.value = "";
    growTbar();
    renderTbar();
    var fail = function (msg) {
      tbar.busy = false;
      if (!els.tbarInput.value) { els.tbarInput.value = v; growTbar(); }   // the message is not lost: it can be sent again
      renderTbar();
      taskNote({ text: msg || "Ассистент не ответил. Попробуйте ещё раз.", failed: true });
    };
    api.tasksAssistant(v).then(function (r) {
      if (!r || !r.ok) { fail(r && r.error); return; }
      applyData(r);
      tbar.busy = false;
      tb.fresh = r.changed || [];
      render();
      tb.fresh = [];
      taskNote({ text: r.reply, failed: r.failed, undoId: r.undoId, cost: r.cost });
      if (state.page === "tasks") els.tbarInput.focus();
    }, function () { fail(); });
  }
  els.tbar.addEventListener("submit", function (e) { e.preventDefault(); sendTbar(els.tbarInput.value); });
  els.tbarInput.addEventListener("input", function () { growTbar(); els.tbarSend.disabled = tbar.busy || !els.tbarInput.value.trim(); });
  els.tbarInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.isComposing) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        els.tbarInput.setRangeText("\n", els.tbarInput.selectionStart, els.tbarInput.selectionEnd, "end");
        els.tbarInput.dispatchEvent(new Event("input"));
      } else if (!e.shiftKey && !e.altKey) {
        e.preventDefault();
        sendTbar(els.tbarInput.value);
      }
    } else if (e.key === "Escape" && els.tbarInput.value) {
      e.stopPropagation();
      els.tbarInput.value = "";
      els.tbarInput.dispatchEvent(new Event("input"));
    }
  });

  /* Notifications in the bottom right corner: what the tasks assistant did, with «Отменить» and the price.
     They slide in, stay about 8 seconds (an error 12), wait while the mouse is over them (the thin line at the bottom
     shows the time left) and slide out. At most three at a time: a new one pushes out the oldest. */
  var NOTE_LIFE = 8, NOTE_LIFE_BAD = 12, NOTES_MAX = 3;
  function closeNote(el) {
    if (el.classList.contains("out")) return;
    el.style.setProperty("--h", el.offsetHeight + "px");   // its height, so the stack closes up smoothly after it fades
    el.classList.add("out");
    setTimeout(function () { el.remove(); }, reducedMotion ? 0 : 420);
  }
  function taskNote(n) {
    var live = Array.prototype.filter.call(els.tnotes.children, function (x) { return !x.classList.contains("out"); });
    while (live.length >= NOTES_MAX) closeNote(live.shift());
    var text = h("p", { class: "tnote-text", text: n.text });
    var acts = h("div", { class: "tnote-acts" });
    var el = h("div", { class: "tnote" + (n.failed ? " bad" : ""), role: n.failed ? "alert" : "status" },
      h("span", { class: "tnote-ico", html: n.failed ? ICONS.x : ICONS.spark, "aria-hidden": "true" }),
      h("div", { class: "tnote-body" }, text, acts),
      h("button", { type: "button", class: "tnote-x", html: ICONS.x, title: "Закрыть", "aria-label": "Закрыть уведомление", onclick: function () { closeNote(el); } }));
    var life = function (sec) {
      el.style.setProperty("--life", sec + "s");
      el.classList.remove("timing");
      void el.offsetWidth;   // restarts the countdown line
      el.classList.add("timing");
    };
    if (n.cost > 0) acts.append(h("span", { class: "tnote-cost", title: "Столько стоил этот ответ (примерно)", text: fmtCost(n.cost) }));
    if (n.undoId) {
      acts.append(h("button", { type: "button", class: "tnote-undo", onclick: function () {
        var btn = this;
        btn.disabled = true;
        call((n.undoFn || api.tasksAssistantUndo)(n.undoId)).then(function (r) {
          if (!r) { btn.disabled = false; return; }
          render();
          text.textContent = n.undoText || "Отменил: задачи вернулись как были до этого сообщения.";
          btn.remove();
          life(4);
        });
      } }, "Отменить"));
    }
    if (!acts.firstChild) acts.remove();
    // The countdown is the line's animation: it pauses on hover by itself, and when it ends the note leaves.
    el.addEventListener("animationend", function (e) { if (e.pseudoElement === "::after" && e.animationName === "tnote-time") closeNote(el); });
    els.tnotes.append(el);
    life(n.failed ? NOTE_LIFE_BAD : NOTE_LIFE);
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
    skEls.view.classList.remove("drop-over");
    Array.prototype.forEach.call(document.querySelectorAll(".tr-drop.over"), function (z) { z.classList.remove("over"); });
  }
  document.addEventListener("dragenter", function (e) { if (hasFiles(e)) dragDepth++; });
  document.addEventListener("dragleave", function (e) { if (hasFiles(e) && --dragDepth <= 0) clearDrag(); });
  document.addEventListener("dragover", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (state.page === "screenshots") { e.dataTransfer.dropEffect = "copy"; return; }
    // «Скиллы»: a .md or .zip can be let go anywhere on the page.
    if (state.page === "prompts" && state.lib === "skills") { e.dataTransfer.dropEffect = "copy"; skEls.view.classList.add("drop-over"); return; }
    // «Транскрибация»: a file can be let go anywhere on the page, the drop zone lights up.
    if (state.page === "transcribe") {
      e.dataTransfer.dropEffect = "copy";
      Array.prototype.forEach.call(document.querySelectorAll(".tr-drop"), function (z) { z.classList.add("over"); });
      return;
    }
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
    if (state.page === "assistant") { clearDrag(); addChatImages(e.dataTransfer.files); return; }
    if (state.page === "prompts" && state.lib === "skills") {
      clearDrag();
      var paths = Array.prototype.filter.call(e.dataTransfer.files || [], function (f) { return /\.(md|markdown|zip)$/i.test(f.name); })
        .map(function (f) { return api.pathForFile(f); }).filter(Boolean);
      if (!paths.length) { toast("Скилл — это файл .md или архив .zip."); return; }
      if (paths.length === 1) api.skillInspect(paths[0]).then(function (r) { if (r && r.ok) openSkillForm(r); else toast((r && r.error) || "Файл не открылся", true); });
      else addSkillFiles(paths);
      return;
    }
    if (state.page === "screenshots" && window.screenshotEditor) { clearDrag(); window.screenshotEditor.importFiles(e.dataTransfer.files); return; }
    if (state.page === "transcribe") {
      clearDrag();
      var media = e.dataTransfer.files && e.dataTransfer.files[0], mp = media && api.pathForFile(media);
      if (mp) api.mediaInfo(mp).then(trSetFile); else toast("Этот файл не открылся. Попробуйте кнопку «Выбрать файл…».");
      return;
    }
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

  /* ---------- «Транскрибация»: text, timings and subtitles of an audio or video file ----------
     The window reads the file and takes its sound out itself (WebAudio at 16 kHz: enough for speech), finds where the voice
     is by loudness, cuts it at pauses and sends the pieces to main.js four at a time; gpt-transcribe (or another
     model) turns each into text. Only the pieces with speech are sent. The borders of phrases and subtitles are then put
     on the real pauses of the voice. Checked in tools/record-test (the test program) before it came here. */
  // note: where the model is best, in two or three words (shown in the list and under it); when: when to pick it, in
  // the hint of the «!» next to it. speakers: the model tells voices apart; its own text is weaker, so the text is
  // written by `text` (the strongest model) on the same recording.
  var TR_MODELS = [
    { id: "gpt-transcribe", name: "GPT transcribe", note: "основная, точнее всех", perMin: 0.0045,
      when: "Когда говорит один человек: урок, ролик, озвучка, голосовая заметка. Точнее всех в словах и знаках препинания. Не знаете, что выбрать, — берите её." },
    { id: "gpt-4o-mini-transcribe", name: "GPT-4o mini transcribe", note: "дешевле, бывают повторы", perMin: 0.003,
      when: "Когда нужно подешевле, а важен общий смысл: например, длинная запись для себя. Иногда вставляет уже сказанный кусок второй раз — перечитайте текст." },
    { id: "gpt-4o-transcribe-diarize", name: "Диалог (diarize + GPT transcribe)", note: "несколько собеседников", perMin: 0.006, speakers: true, text: "gpt-transcribe",
      when: "Когда говорят двое и больше: интервью, созвон, подкаст, круглый стол. Подпишет «Собеседник 1», «Собеседник 2»…, лучше всего различает до 4 голосов; текст напишет GPT transcribe. Дольше и примерно вдвое дороже." }
  ];
  function trModel(id) { return TR_MODELS.find(function (m) { return m.id === id; }) || TR_MODELS[0]; }
  // Per minute of speech; with several voices both models are paid.
  function trPrice(m) { return Math.round((m.perMin + (m.text ? trModel(m.text).perMin : 0)) * 10000) / 10000; }
  function stemOf(name) { return String(name || "").replace(/\.[^.]+$/, ""); }
  function trId() { return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  // 00:12,4 for the screen and the timings; 00:00:12,400 for .srt.
  function trTime(sec, full) {
    var ms = Math.round(Math.max(0, sec) * 1000), hh = Math.floor(ms / 3600000), mm = Math.floor(ms / 60000) % 60, ss = Math.floor(ms / 1000) % 60;
    var p = function (n, w) { return String(n).padStart(w || 2, "0"); };
    if (full) return p(hh) + ":" + p(mm) + ":" + p(ss) + "," + p(ms % 1000, 3);
    return (hh ? hh + ":" : "") + p(mm) + ":" + p(ss) + "," + Math.floor(ms % 1000 / 100);
  }
  function trShort(sec) { var s = Math.floor(sec), m = Math.floor(s / 60); return (m >= 60 ? Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0") : String(m)) + ":" + String(s % 60).padStart(2, "0"); }
  // A local file as an address for <video>: every part of the path is encoded, the drive letter is kept.
  function fileUrl(p) {
    var parts = String(p || "").replace(/\\/g, "/").split("/");
    return "file:///" + parts.map(function (x, i) { return i === 0 && /^[A-Za-z]:$/.test(x) ? x : encodeURIComponent(x); }).join("/");
  }

  // Where the voice is. 30 ms frames; a frame is speech if it is louder than the quiet background of this file.
  // Short gaps inside a phrase are glued; a piece with less than MIN_SPEECH of loud frames is a click or a breath and is
  // not sent. The threshold is soft and the margins are wide on purpose: a lost word is worse than a second of pause.
  // A very long phrase is cut in its longest pause between 12 and 20 seconds (cutting in the quietest single moment
  // can fall inside a word). Every quiet stretch of at least MIN_PAUSE is remembered: timings are put on them.
  var VAD = { FRAME: 0.03, GAP: 0.8, PAD: 0.4, MIN_SPEECH: 0.3, MIN_PAUSE: 0.15, OVER_FLOOR: 7, MAX_LEN: 20, CUT_FROM: 12 };
  function findSpeech(data, rate) {
    var F = VAD.FRAME, size = Math.round(rate * F), n = Math.floor(data.length / size), db = new Float32Array(n), f, i;
    for (f = 0; f < n; f++) {
      var sum = 0;
      for (i = f * size; i < (f + 1) * size; i++) sum += data[i] * data[i];
      db[f] = 10 * Math.log10(sum / size + 1e-12);
    }
    var sorted = Array.prototype.slice.call(db).sort(function (a, b) { return a - b; });
    var floor = sorted[Math.floor(n * 0.2)] || -90, thr = Math.max(floor + VAD.OVER_FLOOR, -60);
    var regions = [], pauses = [], start = -1, last = -1, loud = 0, quiet = -1;
    for (f = 0; f < n; f++) {
      if (db[f] < thr) { if (quiet < 0) quiet = f; continue; }
      if (quiet >= 0 && (f - quiet) * F >= VAD.MIN_PAUSE) pauses.push([quiet * F, f * F]);
      quiet = -1;
      if (start < 0) start = f;
      else if ((f - last) * F > VAD.GAP) { regions.push([start, last, loud]); start = f; loud = 0; }
      last = f; loud++;
    }
    if (start >= 0) regions.push([start, last, loud]);
    var out = [], end = n * F;
    regions.forEach(function (r) {
      if (r[2] * F < VAD.MIN_SPEECH) return;
      // a, b — what is sent (with margins); sa, sb — where the voice really starts and stops (for the timings).
      var p = { a: Math.max(0, r[0] * F - VAD.PAD), b: Math.min(end, (r[1] + 1) * F + VAD.PAD), sa: r[0] * F, sb: (r[1] + 1) * F };
      var prev = out[out.length - 1];
      if (prev && p.a <= prev.b) { p.a = prev.a; p.sa = prev.sa; out.pop(); }
      while (p.b - p.a > VAD.MAX_LEN) {
        var lo = p.a + VAD.CUT_FROM, hi = p.a + VAD.MAX_LEN, best = null;
        pauses.forEach(function (q) { if (q[0] >= lo && q[1] <= hi && (!best || q[1] - q[0] > best[1] - best[0])) best = q; });
        if (!best) best = quietestStretch(db, lo, hi);
        var cut = (best[0] + best[1]) / 2;
        out.push({ a: p.a, b: cut, sa: p.sa, sb: best[0] });
        p = { a: cut, b: p.b, sa: best[1], sb: p.sb };
      }
      out.push(p);
    });
    return { pieces: out, pauses: pauses };
  }
  // No pause at all between 12 and 20 seconds: the quietest quarter of a second there, never one short moment.
  function quietestStretch(db, lo, hi) {
    var F = VAD.FRAME, w = Math.round(0.24 / F), from = Math.floor(lo / F), to = Math.floor(hi / F) - w, best = from, bestSum = Infinity;
    for (var k = from; k <= to; k++) {
      var s = 0;
      for (var j = k; j < k + w; j++) s += db[j];
      if (s < bestSum) { bestSum = s; best = k; }
    }
    return [best * F, (best + w) * F];
  }
  // Splits the time from start to end between parts of text: first by length, then each border moves to the nearest
  // real pause within `reach` seconds — the phrase ends where the voice stops and the next starts where it begins again.
  function placeParts(start, end, parts, pauses, reach) {
    var total = parts.reduce(function (a, p) { return a + p.length; }, 0) || 1;
    var inside = pauses.filter(function (q) { return q[0] > start && q[1] < end; });
    var out = [], from = start, used = -1, acc = 0;
    for (var i = 0; i < parts.length; i++) {
      if (i === parts.length - 1) { out.push([from, end]); break; }
      acc += parts[i].length;
      var guess = start + (end - start) * acc / total, pick = -1;
      for (var k = used + 1; k < inside.length; k++) {
        var mid = (inside[k][0] + inside[k][1]) / 2;
        if (Math.abs(mid - guess) <= reach && (pick < 0 || Math.abs(mid - guess) < Math.abs((inside[pick][0] + inside[pick][1]) / 2 - guess))) pick = k;
      }
      if (pick >= 0) { out.push([from, inside[pick][0]]); from = inside[pick][1]; used = pick; }
      else { out.push([from, guess]); from = guess; }
    }
    return out;
  }
  function splitSentences(text) { return String(text || "").trim().split(/(?<=[.!?…])\s+/).filter(Boolean); }
  // Pieces → phrases. A long piece may be cut in a pause in the middle of a sentence: the halves are glued back.
  // A piece with a speaker gives phrases with it; halves are glued only when it is the same person.
  function sentencesOf(segments, pauses) {
    var out = [];
    segments.forEach(function (s) {
      var parts = splitSentences(s.text);
      placeParts(s.start, s.end, parts, pauses, 3).forEach(function (t, i) {
        var prev = out[out.length - 1];
        if (i === 0 && prev && prev.speaker === s.speaker && !/[.!?…]["»)]?$/.test(prev.text) && t[0] - prev.end < 1.5) { prev.text += " " + parts[0]; prev.end = t[1]; }
        else { var c = { start: t[0], end: t[1], text: parts[i] }; if (s.speaker) c.speaker = s.speaker; out.push(c); }
      });
    });
    return out;
  }
  // Two halves where it reads best: at a comma, dash, colon or semicolon near the middle, else at the space nearest it.
  function halves(text, max) {
    var mid = text.length / 2, best = -1, re = /[,;:]\s|\s[—–-]\s/g, m;
    while ((m = re.exec(text))) { var at = m[0][0] === " " ? m.index : m.index + 1; if (best < 0 || Math.abs(at - mid) < Math.abs(best - mid)) best = at; }
    if (best < text.length * 0.25 || best > text.length * 0.75 || (max && Math.max(best, text.length - best) > max)) {
      best = -1;
      for (var i = 0; i < text.length; i++) if (text[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
    }
    return best <= 0 ? [text] : [text.slice(0, best).trim(), text.slice(best).trim()];
  }
  function chunksOf(text, max) {
    if (text.length <= max) return [text];
    var hv = halves(text);
    return hv.length < 2 ? [text] : chunksOf(hv[0], max).concat(chunksOf(hv[1], max));
  }
  // Subtitles: at most two lines of about 42 letters; a longer phrase becomes several, split at commas and dashes,
  // with their borders on the pauses too.
  function subtitlesOf(t) {
    var out = [];
    t.cues.forEach(function (c) {
      var parts = chunksOf(cueText(c), 84);
      placeParts(c.start, c.end, parts, t.pauses || [], 1.5).forEach(function (x, i) {
        out.push({ start: x[0], end: x[1], text: (parts[i].length > 42 ? halves(parts[i], 44) : [parts[i]]).join("\n") });
      });
    });
    return out;
  }
  function srtOf(t) {
    return subtitlesOf(t).map(function (s, i) { return (i + 1) + "\n" + trTime(s.start, true) + " --> " + trTime(s.end, true) + "\n" + s.text + "\n"; }).join("\n");
  }
  function timingsOf(t, fmt) {
    return t.cues.map(function (c) {
      return fmt === "prompt" ? "[" + trShort(c.start) + "–" + trShort(c.end) + "] " + cueText(c) : trTime(c.start) + " – " + trTime(c.end) + "  " + cueText(c);
    }).join("\n");
  }
  // With several voices every phrase says who it is: «Собеседник 1: …».
  function cueText(c) { return c.speaker ? c.speaker + ": " + c.text : c.text; }
  // Phrases of the same person in a row make one paragraph «Собеседник 1: …»; paragraphs are split by an empty line.
  function speakerGroups(cues) {
    var out = [];
    cues.forEach(function (c) {
      var g = out[out.length - 1];
      if (g && g.speaker === c.speaker) { g.cues.push(c); g.end = c.end; } else out.push({ speaker: c.speaker, start: c.start, end: c.end, cues: [c] });
    });
    return out;
  }
  function speakerText(cues) {
    return speakerGroups(cues).map(function (g) { return g.speaker + ": " + g.cues.map(function (c) { return c.text; }).join(" "); }).join("\n\n");
  }
  function b64(buf) {
    var bytes = new Uint8Array(buf), out = "";
    for (var i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }
  // Several voices (the diarize model). It must hear long stretches to tell people apart, so the recording goes in
  // parts of up to 9 minutes cut in the longest pause; a WAV of 9 minutes is about 17 MB, under the 25 MB of OpenAI.
  // After a part, 2–10 seconds of every new voice go along with the next parts (up to 4), so people keep their names.
  var DIAR = { MAX: 540, CUT_FROM: 420, REF_MIN: 2, REF_MAX: 10, REFS: 4 };
  async function trDiarize(audio, found) {
    var pcs = found.pieces, S = pcs[0].a, E = pcs[pcs.length - 1].b, parts = [], a = S;
    while (E - a > DIAR.MAX) {
      var lo = a + DIAR.CUT_FROM, hi = a + DIAR.MAX, best = null;
      found.pauses.forEach(function (q) { if (q[0] >= lo && q[1] <= hi && (!best || q[1] - q[0] > best[1] - best[0])) best = q; });
      var cut = best ? (best[0] + best[1]) / 2 : hi;
      parts.push([a, cut]); a = cut;
    }
    parts.push([a, E]);
    var refs = [], count = 0, segs = [], usd = 0;
    for (var pi = 0; pi < parts.length; pi++) {
      if (tr.stop) return null;
      var p = parts[pi];
      trProgress(8 + 42 * pi / parts.length, "Различаю голоса: часть " + (pi + 1) + " из " + parts.length + "… Можно уйти в другую вкладку — расшифровка продолжится.");
      var res = await api.transcribeDiarize(await pieceWav(audio, p[0], p[1]), refs, p[1] - p[0]);
      if (!res || !res.ok) throw new Error((res && res.error) || "OpenAI не ответил.");
      usd += res.usd || 0;
      // A label is a known name (from the voice samples) or a letter: letters become «Собеседник N» in order of appearance.
      var names = {}, fresh = [];
      res.segments.forEach(function (x) {
        var label = x.speaker || "?", name;
        if (refs.some(function (r) { return r.name === label; })) name = label;
        else if (names[label]) name = names[label];
        else { name = "Собеседник " + (++count); names[label] = name; fresh.push(name); }
        segs.push({ start: p[0] + x.start, end: p[0] + x.end, text: x.text, speaker: name });
      });
      for (var fi = 0; fi < fresh.length && refs.length < DIAR.REFS; fi++) {
        var who = fresh[fi];
        var own = segs.filter(function (x) { return x.speaker === who && x.end - x.start >= DIAR.REF_MIN; }).sort(function (x, y) { return (y.end - y.start) - (x.end - x.start); })[0];
        if (own) refs.push({ name: who, data: "data:audio/wav;base64," + b64(await pieceWav(audio, own.start, Math.min(own.end, own.start + DIAR.REF_MAX))) });
      }
    }
    var cues = [];
    segs.forEach(function (x) {
      var ps = splitSentences(x.text);
      placeParts(x.start, x.end, ps, found.pauses, 3).forEach(function (t, i) {
        var prev = cues[cues.length - 1];
        if (i === 0 && prev && prev.speaker === x.speaker && !/[.!?…]["»)]?$/.test(prev.text) && t[0] - prev.end < 1.5) { prev.text += " " + ps[0]; prev.end = t[1]; }
        else cues.push({ start: t[0], end: t[1], text: ps[i], speaker: x.speaker });
      });
    });
    return { cues: cues, text: speakerText(cues), usd: usd, sent: E - S, parts: parts.length };
  }
  // Where the voice changes (by the diarize model), moved to the nearest pause within a second: the pieces for the text
  // model are cut there, so every piece is one person and gets that person's name.
  function turnPieces(pieces, cues, pauses) {
    var groups = speakerGroups(cues), cuts = [], out = [];
    for (var i = 1; i < groups.length; i++) {
      var at = (groups[i - 1].end + groups[i].start) / 2, q = null;
      pauses.forEach(function (x) { var m = (x[0] + x[1]) / 2; if (Math.abs(m - at) <= 1 && (!q || Math.abs(m - at) < Math.abs((q[0] + q[1]) / 2 - at))) q = x; });
      cuts.push(q || [at, at]);
    }
    pieces.forEach(function (p) {
      p = { a: p.a, b: p.b, sa: p.sa, sb: p.sb };
      cuts.forEach(function (q) {
        var m = (q[0] + q[1]) / 2;
        if (m <= p.sa + 0.3 || m >= p.sb - 0.3) return;
        out.push({ a: p.a, b: m, sa: p.sa, sb: Math.max(p.sa, q[0]) });
        p = { a: m, b: p.b, sa: Math.min(p.sb, q[1]), sb: p.sb };
      });
      out.push(p);
    });
    out.forEach(function (p) { p.speaker = whoAt(groups, p.sa, p.sb); });
    return out;
  }
  // The person who speaks most of the time from a to b; if nobody does (the diarize model heard nothing there), the nearest.
  function whoAt(groups, a, b) {
    var best = null, most = 0, near = Infinity;
    groups.forEach(function (g) { var o = Math.min(b, g.end) - Math.max(a, g.start); if (o > most) { most = o; best = g.speaker; } });
    if (best) return best;
    groups.forEach(function (g) { var d = Math.max(g.start - b, a - g.end); if (d < near) { near = d; best = g.speaker; } });
    return best;
  }
  // A piece as WAV, 16 kHz mono: small, and OpenAI takes it as it is.
  function pieceWav(audio, a, b) {
    var rate = 16000, len = Math.max(1, Math.ceil((b - a) * rate));
    var off = new OfflineAudioContext(1, len, rate), src = off.createBufferSource();
    src.buffer = audio; src.connect(off.destination); src.start(0, a, b - a);
    return off.startRendering().then(function (out) {
      var pcm = out.getChannelData(0), buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
      var str = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
      v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, pcm.length * 2, true);
      for (var i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
      return buf;
    });
  }

  function trSetFile(info) {
    if (!info || info.canceled) return;
    if (!info.ok) { toast(info.error || "Этот файл не подходит.", true); return; }
    if (tr.busy) { toast("Дождитесь, пока закончится расшифровка, или остановите её."); return; }
    tr.file = info; tr.open = null; tr.error = ""; tr.subs = null;
    trDuration(info);
    if (state.page !== "transcribe") setPage("transcribe"); else render();
  }
  // How long the file is, from its header (the window reads only the start of it): for the price before the work.
  // Only speech is paid, so the real price is the same or a little lower.
  function trDuration(f) {
    var el = document.createElement(f.kind === "audio" ? "audio" : "video");
    el.preload = "metadata";
    el.addEventListener("loadedmetadata", function () {
      if (isFinite(el.duration) && el.duration > 0) { f.duration = el.duration; if (tr.file === f && !tr.busy) render(); }
      el.removeAttribute("src"); el.load();
    });
    el.src = f.url || fileUrl(f.file);
  }
  // «≈ $0.03 за этот файл» when the length is known, else the price of a minute.
  function trCost(m, f) { return f && f.duration ? trFilePrice(m, f) + " за этот файл" : "≈ $" + trPrice(m) + " за минуту"; }
  function trFilePrice(m, f) { var usd = trPrice(m) * f.duration / 60; return usd < 0.01 ? "меньше $0.01" : "примерно $" + usd.toFixed(2); }
  function trPick() { api.mediaPick().then(trSetFile, function () { toast("Не получилось выбрать файл."); }); }
  function trProgress(p, text) {
    tr.prog = p; if (text) tr.progText = text;
    var bar = els.trMain.querySelector(".tr-bar b"), t = els.trMain.querySelector(".tr-prog .tr-soft");
    if (bar) bar.style.width = Math.min(100, Math.round(p)) + "%";
    if (t) t.textContent = tr.progText;
  }
  function trFail(text) { tr.busy = false; tr.error = text; render(); }

  async function trRun() {
    // A model no longer in the list (remembered from an older version) becomes the main one.
    var f = tr.file, model = trModel(tr.model).id;
    if (!f || tr.busy) return;
    tr.modelMenu = false;
    if (!assistantState().keys.openai) { tr.error = "Для расшифровки нужен ключ ChatGPT."; render(); return; }
    tr.busy = true; tr.stop = false; tr.error = ""; trProgress(2, "Читаю файл и достаю звук…");
    render();
    var r, audio;
    try { r = await api.mediaRead(f.file); } catch (e) { r = null; }
    if (!r || !r.ok) { trFail((r && r.error) || "Файл не прочитался."); return; }
    try { audio = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(r.data); }
    catch (e) { trFail("Не получилось достать звук из этого файла: возможно, в нём нет звуковой дорожки или такой формат не открывается."); return; }
    r = null;
    var mono = audio.getChannelData(0);
    if (audio.numberOfChannels > 1) {
      mono = new Float32Array(audio.length);
      for (var c = 0; c < audio.numberOfChannels; c++) { var ch = audio.getChannelData(c); for (var i = 0; i < ch.length; i++) mono[i] += ch[i] / audio.numberOfChannels; }
    }
    var found = findSpeech(mono, audio.sampleRate), pieces = found.pieces, n = pieces.length;
    mono = null;
    if (!n) { trFail("В файле не нашлось речи: звук есть, но он слишком тихий или это только музыка."); return; }
    // Several voices: first the diarize model says who speaks when, then the strongest model writes the text of the
    // same pieces, cut where the voice changes. Its text with the names of the diarize model is the result.
    var textModel = model, d = null, from = 8;
    if (trModel(model).speakers) {
      try { d = await trDiarize(audio, found); } catch (e) { trFail(e.message); return; }
      if (!d) { tr.busy = false; tr.error = ""; render(); toast("Расшифровка остановлена."); return; }
      if (!d.cues.length) { trFail("В записи не нашлось речи, которую получилось расшифровать."); return; }
      textModel = trModel(model).text; pieces = turnPieces(pieces, d.cues, found.pauses); n = pieces.length; from = 50;
    }
    trProgress(from, (d ? "Голоса различены. Пишу текст: кусков " : "Нашёл кусков с речью: ") + n + ". Расшифровываю…");
    var texts = new Array(n), next = 0, done = 0, sent = 0, usd = 0, failed = null;
    var before = function (k) { var s = ""; for (var j = 0; j < k; j++) if (texts[j]) s += " " + texts[j]; return s.slice(-600).trim(); };
    var worker = async function () {
      while (next < n && !failed && !tr.stop) {
        var k = next++, p = pieces[k];
        var res = await api.transcribePiece(await pieceWav(audio, p.a, p.b), before(k), textModel, p.b - p.a);
        if (!res || !res.ok) { failed = (res && res.error) || "OpenAI не ответил."; return; }
        texts[k] = res.text; sent += p.b - p.a; usd += res.usd || 0;
        trProgress(from + (96 - from) * (++done) / n, (d ? "Пишу текст: готово кусков " : "Расшифровано кусков: ") + done + " из " + n + "… Можно уйти в другую вкладку — расшифровка продолжится.");
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (tr.stop) { tr.busy = false; tr.error = ""; render(); toast("Расшифровка остановлена."); return; }
    if (failed && d) {
      // The voices are already paid for: keep their own text rather than lose everything.
      await trSaveResult(f, audio, model, found, d.text, d.cues, d.usd + usd, d.sent, d.parts, "");
      toast("Текст написала модель, которая различала голоса: вторая не ответила (" + failed + ")", true);
      return;
    }
    if (failed) { trFail(failed); return; }
    var segments = pieces.map(function (p, k) { var s = { start: p.sa, end: p.sb, text: texts[k] || "" }; if (p.speaker) s.speaker = p.speaker; return s; }).filter(function (s) { return s.text; });
    var cues = sentencesOf(segments, found.pauses);
    if (d) await trSaveResult(f, audio, model, found, speakerText(cues), cues, d.usd + usd, sent, n, textModel);
    else await trSaveResult(f, audio, model, found, segments.map(function (s) { return s.text; }).join(" "), cues, usd, sent, n);
  }
  async function trSaveResult(f, audio, model, found, text, cues, usd, sent, n, textModel) {
    var saved = await call(api.transcriptSave({
      id: trId(), name: f.name, source: f.file, kind: f.kind, size: f.size, duration: audio.duration, model: model, textModel: textModel || "",
      text: text, cues: cues,
      pauses: found.pauses.map(function (q) { return [Math.round(q[0] * 1000) / 1000, Math.round(q[1] * 1000) / 1000]; }),
      usd: usd, sent: sent, pieces: n
    }));
    tr.busy = false;
    if (!saved) { tr.error = "Расшифровка готова, но не сохранилась. Попробуйте ещё раз."; render(); return; }
    tr.list = saved.transcripts; tr.open = saved.transcript; tr.file = null; tr.view = "text"; tr.subs = null;
    render();
    var people = trSpeakers(cues).length;
    toast("Готово: «" + f.name + "» — " + cues.length + " " + plural(cues.length, "фраза", "фразы", "фраз") + (people ? ", " + people + " " + plural(people, "собеседник", "собеседника", "собеседников") : "") + (usd ? ", около $" + usd.toFixed(4) : "") + ".");
  }
  function trSpeakers(cues) { var seen = []; cues.forEach(function (c) { if (c.speaker && seen.indexOf(c.speaker) === -1) seen.push(c.speaker); }); return seen; }

  function trOpen(id) {
    if (tr.open && tr.open.id === id) return;
    api.transcriptGet(id).then(function (r) {
      if (!r || !r.ok) { toast((r && r.error) || "Не открылось.", true); return; }
      tr.open = r.transcript; tr.subs = null; tr.view = "text";
      if (!tr.busy) tr.file = null;
      render();
    });
  }
  // The same transcription changed in another window: take the fresh copy, keep what is shown.
  function trOpenFresh(id) {
    api.transcriptGet(id).then(function (r) {
      if (!r || !r.ok || !tr.open || tr.open.id !== id || r.transcript.updatedAt === tr.open.updatedAt) return;
      tr.open = r.transcript; tr.subs = null;
      render();
    }, function () {});
  }
  function trRemove(item) {
    api.transcriptGet(item.id).then(function (r) {
      var copy = r && r.ok ? r.transcript : null;
      call(api.transcriptDelete(item.id)).then(function (d) {
        if (!d) return;
        tr.list = d.transcripts;
        if (tr.open && tr.open.id === item.id) tr.open = null;
        render();
        if (copy) undoToast("Расшифровка «" + item.name + "» удалена", function () {
          call(api.transcriptRestore(copy)).then(function (x) { if (x) { tr.list = x.transcripts; render(); } });
        });
      });
    });
  }
  // The text was corrected: the same number of sentences keeps their times; otherwise the new sentences are spread over
  // the whole length again and put on the pauses.
  function trEditText(value) {
    var t = tr.open, text = String(value || "").trim();
    if (!t || text === t.text) return;
    if (trSpeakers(t.cues).length) { trEditSpeakers(t, text); return; }
    var parts = splitSentences(text), cues;
    if (!parts.length) return;
    if (parts.length === t.cues.length) cues = t.cues.map(function (c, i) { return { start: c.start, end: c.end, text: parts[i] }; });
    else {
      var a = t.cues.length ? t.cues[0].start : 0, b = t.cues.length ? t.cues[t.cues.length - 1].end : t.duration;
      cues = placeParts(a, b, parts, t.pauses || [], 3).map(function (x, i) { return { start: x[0], end: x[1], text: parts[i] }; });
    }
    call(api.transcriptSave({ id: t.id, text: text, cues: cues })).then(function (r) {
      if (!r) return;
      tr.open = r.transcript; tr.list = r.transcripts; tr.subs = null;
      toast("Правка сохранена, тайминги и субтитры обновились.");
      if (tr.view !== "text") render();
    });
  }
  // With several voices the text is paragraphs «Имя: …». Each paragraph keeps its time; the name before the colon can be
  // changed («Собеседник 2» → «Дима») and stays only for that paragraph. Adding or removing paragraphs is not possible:
  // the program would not know whose words they are.
  function trEditSpeakers(t, text) {
    var groups = speakerGroups(t.cues), paras = text.split(/\n\s*\n/).map(function (x) { return x.trim(); }).filter(Boolean);
    var parsed = paras.map(function (x) { var m = x.match(/^([^:\n]{1,40}):\s*([\s\S]+)$/); return m ? { speaker: m[1].trim(), text: m[2].replace(/\s+/g, " ").trim() } : null; });
    if (parsed.length !== groups.length || parsed.some(function (x) { return !x; })) {
      toast("Правка не сохранилась: в записи с несколькими собеседниками правьте текст внутри абзацев и оставляйте «Имя:» в начале каждого.", true);
      render();
      return;
    }
    var cues = [];
    groups.forEach(function (g, i) {
      var ps = splitSentences(parsed[i].text);
      placeParts(g.start, g.end, ps, t.pauses || [], 3).forEach(function (x, k) { cues.push({ start: x[0], end: x[1], text: ps[k], speaker: parsed[i].speaker }); });
    });
    call(api.transcriptSave({ id: t.id, text: speakerText(cues), cues: cues })).then(function (r) {
      if (!r) return;
      tr.open = r.transcript; tr.list = r.transcripts; tr.subs = null;
      toast("Правка сохранена, тайминги и субтитры обновились.");
      render();
    });
  }
  function trSummary() {
    var t = tr.open;
    if (!t || tr.sumBusy) return;
    tr.sumBusy = true; render();
    call(api.transcriptSummary(t.id)).then(function (r) {
      tr.sumBusy = false;
      if (r && tr.open && tr.open.id === t.id) { tr.open = r.transcript; tr.list = r.transcripts; if (r.info) state.info = r.info; }
      render();
    });
  }
  function trCopy(text, done) { call(api.transcriptCopy(text)).then(function (r) { if (r) toast(done); }); }
  function summaryText(s) { return s.brief + (s.points.length ? "\n\n" + s.points.map(function (x) { return "— " + x; }).join("\n") : ""); }
  function trExport(kind) {
    var t = tr.open;
    if (!t) return;
    var content = kind === "srt" ? srtOf(t) : t.text + "\n\nТайминги:\n" + timingsOf(t, "plain") + "\n";
    call(api.transcriptExport(t.id, kind, content)).then(function (r) {
      if (r && !r.canceled) toast((kind === "srt" ? "Субтитры сохранены: " : "Текст сохранён: ") + r.path + (kind === "srt" ? ". Перетащите файл на таймлайн в монтаже." : ""), true);
    });
  }
  // «Спросить в LLM»: a new conversation with the text and the timings already in the box.
  function trToLlm() {
    var t = tr.open;
    if (!t) return;
    openTab("assistant", { fresh: true });
    var cur = activeTab();
    if (!cur || !cur.session) return;
    var text = "Вот расшифровка «" + t.name + "» с таймингами:\n\n" + timingsOf(t, "prompt") + "\n\n";
    cur.session.draft = text;
    els.chatInput.value = text;
    growInput();
    els.chatInput.focus();
    els.chatInput.setSelectionRange(text.length, text.length);
  }

  function trDrop() {
    return h("div", { class: "tr-drop" },
      h("span", { class: "big", html: ICONS.upload, "aria-hidden": "true" }),
      h("div", null, h("b", { text: "Перетащите аудио или видео сюда" }),
        h("p", { text: "mp4, mov, mkv, webm, mp3, m4a, wav, ogg, flac. Звук из видео программа достанет сама. Файл — до 2 ГБ, длина любая: на расшифровку уходят только куски с речью." })),
      h("button", { type: "button", class: "btn btn-primary", onclick: trPick }, "Выбрать файл…"));
  }
  // «Новая транскрибация» above the history: back to the start screen (the file is chosen with «Выбрать файл…» or
  // dropped anywhere on the page); the open transcription stays in the history.
  function trNew() {
    if (tr.busy) { toast("Дождитесь, пока закончится расшифровка, или остановите её."); return; }
    tr.open = null; tr.file = null; tr.error = ""; tr.subs = null;
    render();
  }
  // The model list: a button and a menu like «Модель» in LLM. Next to every model a «!»: hovering it (or focusing it with
  // Tab) shows when to pick this model, so nobody has to open the guide for it.
  function trModelPick(m) {
    var btn = h("button", { type: "button", class: "tr-mbtn", "aria-haspopup": "true", "aria-expanded": String(!!tr.modelMenu),
      onclick: function () { tr.modelMenu = !tr.modelMenu; render(); if (tr.modelMenu) trFocusModel(); } },
      h("span", { class: "nm", text: m.name }), h("span", { class: "tr-soft", text: m.note }), h("span", { class: "chev", html: ICONS.chevron, "aria-hidden": "true" }));
    var wrap = h("div", { class: "tr-mpick" }, btn);
    if (tr.modelMenu) {
      wrap.append(h("div", { class: "model-menu tr-mmenu", role: "menu", "aria-label": "Модель" }, TR_MODELS.map(function (x) {
        var item = modelOption({ name: x.name, text: x.note + " · " + trCost(x, tr.file) }, x.id === m.id, function () {
          tr.model = x.id; tr.modelMenu = false;
          try { localStorage.setItem("trModel2", tr.model); } catch (e) {}
          render();
          var b = els.trMain.querySelector(".tr-mbtn"); if (b) b.focus();
        });
        return h("div", { class: "tr-mrow" }, item,
          h("span", { class: "tr-why", tabindex: "0", role: "note", "aria-label": "Когда выбирать: " + x.when },
            h("span", { class: "ic", html: ICONS.alert, "aria-hidden": "true" }),
            h("span", { class: "tr-tip", "aria-hidden": "true" }, h("b", { text: "Когда выбирать" }), h("span", { text: x.when }))));
      })));
    }
    return wrap;
  }
  function trFocusModel() { var c = els.trMain.querySelector('.tr-mmenu .mm-item[aria-checked="true"]'); if (c) c.focus(); }
  function trCloseModels(focus) {
    if (!tr.modelMenu) return;
    tr.modelMenu = false; render();
    if (focus) { var b = els.trMain.querySelector(".tr-mbtn"); if (b) b.focus(); }
  }
  document.addEventListener("mousedown", function (e) { if (tr.modelMenu && !e.target.closest(".tr-mpick")) trCloseModels(false); });
  document.addEventListener("keydown", function (e) {
    if (!tr.modelMenu || !document.activeElement || !document.activeElement.closest(".tr-mpick")) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); trCloseModels(true); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    var items = Array.prototype.slice.call(els.trMain.querySelectorAll(".tr-mmenu .mm-item")), i = items.indexOf(document.activeElement);
    e.preventDefault();
    var next = items[(i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    if (next) next.focus();
  }, true);
  function trFileCard() {
    var f = tr.file, m = trModel(tr.model);
    var card = h("section", { class: "card tr-file" },
      h("div", { class: "tr-file-h" }, h("span", { class: "tr-ic" + (f.kind === "audio" ? " audio" : ""), html: f.kind === "audio" ? ICONS.music : ICONS.film, "aria-hidden": "true" }),
        h("div", { class: "nm" }, h("b", { text: f.name }), h("span", { text: (f.kind === "audio" ? "Аудио" : "Видео") + " · " + (f.size / 1048576).toFixed(1).replace(".", ",") + " МБ" })),
        tr.busy ? null : h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: function () { tr.file = null; tr.error = ""; render(); } }, "Убрать")));
    if (tr.busy) {
      card.append(h("div", { class: "tr-prog" },
        h("div", { class: "tr-bar" }, h("b")), h("span", { class: "tr-soft", text: tr.progText }),
        h("div", null, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: function () { tr.stop = true; trProgress(tr.prog, "Останавливаю…"); } }, "Остановить"))));
      setTimeout(function () { trProgress(tr.prog); }, 0);
    } else {
      card.append(h("div", { class: "tr-opts" }, "Модель:", trModelPick(m),
        h("span", { class: "tr-soft", text: (f.duration ? "Этот файл (" + trShort(f.duration) + ") — " + trFilePrice(m, f) + " · " : "") + "$" + trPrice(m) + " за минуту речи" + (m.speakers ? " · голоса различит эта модель («Собеседник 1», «Собеседник 2»…, до 4), а текст напишет " + trModel(m.text).name : "") + " · ключ ChatGPT из «Настроек»" }), h("span", { class: "grow" }),
        h("button", { type: "button", class: "btn btn-primary", onclick: trRun }, "Расшифровать")));
    }
    if (tr.error) card.append(h("p", { class: "tr-err", text: tr.error }));
    return card;
  }
  // The result: the file with subtitles over it, a strip of phrases, then «Текст / Тайминги / Кратко» and the buttons.
  // The player is made once per transcription and kept across redraws, so playing does not stop when the window redraws.
  var trUi = null;
  function trPlayerOf(t) {
    if (trUi && trUi.id === t.id && trUi.text === t.text) return trUi;
    trDropPlayer();
    if (!tr.subs) tr.subs = subtitlesOf(t);
    var ui = { id: t.id, text: t.text, cueEls: [] };
    var subLine = h("div", { class: "tr-sub", "aria-live": "off" });
    var media = h(t.kind === "audio" ? "audio" : "video", { controls: "controls", preload: "metadata", src: fileUrl(t.source) });
    var player = h("div", { class: "tr-player" + (t.kind === "audio" ? " audio" : "") });
    if (t.kind === "audio") player.append(subLine, media); else player.append(media, subLine);
    var strip = h("div", { class: "tr-tl", title: "Фразы на полоске времени: клик перематывает" });
    var len = t.duration || (t.cues.length ? t.cues[t.cues.length - 1].end : 1);
    t.cues.forEach(function (c) {
      var i = h("i");
      i.style.left = (c.start / len * 100) + "%";
      i.style.width = Math.max(0.3, (c.end - c.start) / len * 100) + "%";
      strip.append(i);
    });
    strip.addEventListener("click", function (e) { var r = strip.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * len); });
    var gone = h("div", { class: "tr-gone", hidden: true }, "Исходного файла на прежнем месте нет, поэтому смотреть нельзя. Текст, тайминги и субтитры сохранились.");
    media.addEventListener("error", function () { player.hidden = true; gone.hidden = false; });
    // Only the subtitle line, the strip and the current phrase change while it plays — no full redraw.
    function paint(time) {
      var s = tr.subs && tr.subs.find(function (x) { return time >= x.start && time < x.end; });
      subLine.textContent = s ? s.text : "";
      Array.prototype.forEach.call(strip.children, function (el, i) { el.classList.toggle("on", time >= t.cues[i].start && time < t.cues[i].end); });
      ui.cueEls.forEach(function (el, i) { el.classList.toggle("now", time >= t.cues[i].start && time < t.cues[i].end); });
    }
    function seek(sec) { try { media.currentTime = Math.max(0, sec); } catch (e) {} paint(sec); }
    media.addEventListener("timeupdate", function () { paint(media.currentTime); });
    ui.media = media; ui.nodes = [player, gone, strip]; ui.seek = seek; ui.paint = paint;
    trUi = ui;
    return ui;
  }
  function trDropPlayer() {
    if (trUi && trUi.media) { try { trUi.media.pause(); } catch (e) {} }
    trUi = null;
  }
  function trResult() {
    var t = tr.open, ui = trPlayerOf(t), seek = ui.seek;
    ui.cueEls = [];

    var seg = h("div", { class: "tr-seg", role: "group", "aria-label": "Что показать" }, [["text", "Текст"], ["cues", "Тайминги"], ["sum", "Кратко"]].map(function (v) {
      return h("button", { type: "button", "aria-pressed": String(tr.view === v[0]), onclick: function () { tr.view = v[0]; render(); } }, v[1]);
    }));
    var tabsRow = h("div", { class: "tr-tabs" }, seg, h("span", { class: "grow" }),
      h("span", { class: "tr-soft", text: trShort(t.duration) + " · " + t.cues.length + " " + plural(t.cues.length, "фраза", "фразы", "фраз") + (trSpeakers(t.cues).length ? " · " + trSpeakers(t.cues).length + " " + plural(trSpeakers(t.cues).length, "собеседник", "собеседника", "собеседников") : "") + " · " + (t.textModel ? "голоса: " + t.model + ", текст: " + t.textModel : t.model) + (t.usd ? " · ≈ $" + t.usd.toFixed(4) : "") }));
    var body = h("div", { class: "tr-body" });
    if (tr.view === "text") {
      var ta = h("textarea", { class: "tr-text", "aria-label": "Текст расшифровки", spellcheck: "true" });
      ta.value = t.text;
      ta.addEventListener("change", function () { trEditText(ta.value); });
      body.append(ta, h("p", { class: "tr-hint", text: trSpeakers(t.cues).length
        ? "Каждый абзац — один собеседник. Чтобы подписать человека по имени, замените «Собеседник 2» на имя в его абзацах. Текст можно править внутри абзаца; правка сохранится, когда вы щёлкнете мимо поля, и попадёт в тайминги и субтитры."
        : "Текст можно поправить прямо здесь: например, имя или название, которое модель расслышала неверно. Правка сохранится, когда вы щёлкнете мимо поля, и попадёт в тайминги и субтитры." }));
    } else if (tr.view === "cues") {
      var fmtSeg = h("div", { class: "tr-seg", role: "group", "aria-label": "Как копировать" }, [["plain", "00:12,4 – 00:15,8  текст"], ["prompt", "[0:12–0:15] текст"]].map(function (v) {
        return h("button", { type: "button", "aria-pressed": String(tr.fmt === v[0]), onclick: function () { tr.fmt = v[0]; try { localStorage.setItem("trFmt", tr.fmt); } catch (e) {} render(); } }, v[1]);
      }));
      body.append(h("div", { class: "tr-copyfmt" }, "Копировать как:", fmtSeg,
        h("button", { type: "button", class: "btn btn-ghost btn-sm", html: ICONS.copy, onclick: function () { trCopy(timingsOf(t, tr.fmt), "Тайминги скопированы."); } }, "Копировать")));
      var list = h("div", { class: "tr-cues" });
      t.cues.forEach(function (c) {
        var b = h("button", { type: "button", class: "tr-cue", onclick: function () { seek(c.start + 0.05); } },
          h("span", { class: "tm", text: tr.fmt === "prompt" ? "[" + trShort(c.start) + "–" + trShort(c.end) + "]" : trTime(c.start) + " – " + trTime(c.end) }),
          h("span", null, c.speaker ? h("b", { class: "tr-who", text: c.speaker + ": " }) : null, c.text));
        ui.cueEls.push(b); list.append(b);
      });
      body.append(list, h("p", { class: "tr-hint", text: "Нажмите на фразу — плеер перемотается на неё. Время стоит на настоящих паузах голоса, примерно до четверти секунды." }));
    } else {
      var sum = h("div", { class: "tr-sum" });
      if (!t.summary) {
        sum.append(h("div", { class: "tr-sum-empty" }, "Краткое содержание делается по кнопке: так вы не платите, когда оно не нужно.",
          h("button", { type: "button", class: "btn btn-primary btn-sm", html: ICONS.spark, disabled: tr.sumBusy ? "disabled" : null, onclick: trSummary }, tr.sumBusy ? "Пишу…" : "Сделать кратко")));
      } else {
        var ul = h("ul");
        t.summary.points.forEach(function (x) { ul.append(h("li", { text: x })); });
        sum.append(h("h4", { text: "Кратко" }), h("p", { text: t.summary.brief }), t.summary.points.length ? h("h4", { text: "Главные мысли" }) : null, t.summary.points.length ? ul : null,
          h("p", { class: "tr-hint" }, h("button", { type: "button", class: "link-btn", disabled: tr.sumBusy ? "disabled" : null, onclick: trSummary }, tr.sumBusy ? "Пишу…" : "Сделать заново")));
      }
      body.append(sum);
    }
    // The copy button copies what the open tab shows: the text, the timings (in the chosen form) or the summary.
    var copy = tr.view === "cues" ? { label: "Копировать тайминги", text: timingsOf(t, tr.fmt), done: "Тайминги скопированы." }
      : tr.view === "sum" ? { label: "Копировать кратко", text: t.summary ? summaryText(t.summary) : "", done: "Краткое содержание скопировано." }
      : { label: "Копировать текст", text: t.text, done: "Текст скопирован." };
    var acts = h("div", { class: "tr-acts" },
      h("button", { type: "button", class: "btn btn-ghost btn-sm", html: ICONS.copy, disabled: copy.text ? null : "disabled", title: copy.text ? null : "Сначала сделайте краткое содержание",
        onclick: function () { trCopy(copy.text, copy.done); } }, copy.label),
      h("button", { type: "button", class: "btn btn-ghost btn-sm", html: ICONS.download, onclick: function () { trExport("srt"); } }, "Субтитры .srt"),
      h("button", { type: "button", class: "btn btn-ghost btn-sm", html: ICONS.download, onclick: function () { trExport("txt"); } }, ".txt"),
      h("button", { type: "button", class: "btn btn-ghost btn-sm", html: ICONS.chat, onclick: trToLlm }, "Спросить в LLM"),
      h("span", { class: "grow" }),
      h("button", { type: "button", class: "link-btn", onclick: function () { api.transcriptShowSource(t.id).then(function (r) { if (!r || !r.ok) toast((r && r.error) || "Не открылось."); }); } }, "Показать исходный файл"));
    var card = h("section", { class: "card tr-res" }, ui.nodes, tabsRow, body, acts);
    if (ui.media) ui.paint(ui.media.currentTime || 0);
    return card;
  }
  function trHistory() {
    var q = tr.q.trim().toLowerCase(), kids = [], lastDay = null, now = new Date(), today = dayKey(now);
    var yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    tr.list.forEach(function (x) {
      if (q && (x.name + " " + x.words).toLowerCase().indexOf(q) === -1) return;
      var d = dayKey(new Date(x.createdAt));
      if (d !== lastDay) { lastDay = d; kids.push(h("p", { class: "tr-day", text: d === today ? "Сегодня" : d === yesterday ? "Вчера" : longDay(d) })); }
      kids.push(h("div", { class: "tr-item" + (tr.open && tr.open.id === x.id ? " on" : "") },
        h("button", { type: "button", class: "tr-open", title: x.name, onclick: function () { trOpen(x.id); } },
          h("span", { class: "tr-ic" + (x.kind === "audio" ? " audio" : ""), html: x.kind === "audio" ? ICONS.music : ICONS.film, "aria-hidden": "true" }),
          h("span", null, h("span", { class: "nm", text: x.name }), h("span", { class: "sb", text: trShort(x.duration) + " · " + x.first }))),
        h("button", { type: "button", class: "tr-del", title: "Удалить", "aria-label": "Удалить расшифровку «" + x.name + "»", html: ICONS.x, onclick: function () { trRemove(x); } })));
    });
    if (tr.busy && tr.file) kids.unshift(h("div", { class: "tr-item" }, h("button", { type: "button", class: "tr-open", onclick: function () { tr.open = null; render(); } },
      h("span", { class: "tr-ic" + (tr.file.kind === "audio" ? " audio" : ""), html: tr.file.kind === "audio" ? ICONS.music : ICONS.film, "aria-hidden": "true" }),
      h("span", null, h("span", { class: "nm", text: tr.file.name }), h("span", { class: "sb", text: "Расшифровывается…" }))), h("span", { class: "tr-run" })));
    if (!kids.length) kids.push(h("p", { class: "tr-empty", text: q ? "Ничего не нашлось." : "Пока пусто: здесь будут все расшифрованные файлы." }));
    els.trList.replaceChildren.apply(els.trList, kids);
  }
  function renderTranscribe() {
    var kids = [];
    if (!tr.open || (trUi && trUi.id !== tr.open.id)) trDropPlayer();
    if (!assistantState().keys.openai) kids.push(h("div", { class: "tr-nokey" }, h("span", { text: "Для расшифровки нужен ключ ChatGPT (OpenAI). Ключ Claude не подходит: звук в текст переводит только OpenAI." }),
      h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: function () { openSettings("keys"); } }, "Подключить ChatGPT")));
    if (tr.file && (tr.busy || !tr.open)) kids.push(trFileCard());
    if (tr.open) kids.push(trResult());
    else if (!tr.file) kids.push(trDrop());
    var keep = els.trMain.querySelector(".tr-text");
    if (keep && document.activeElement === keep) { trHistory(); return; }   // typing in the text: do not throw it away
    els.trMain.replaceChildren.apply(els.trMain, kids);
    trHistory();
  }
  els.trSearch.addEventListener("input", function () { tr.q = els.trSearch.value; trHistory(); });
  $("tr-new").addEventListener("click", trNew);
  function refreshTranscripts() { api.transcriptList().then(function (r) { if (r && r.ok) { tr.list = r.transcripts; if (state.page === "transcribe" || state.page === "home") render(); } }, function () {}); }
  refreshTranscripts();

  /* ---------- guides «Как пользоваться» ----------
     Every update with something new to show brings a guide (src/guides/guides.js): steps with real screenshots,
     frames around the new buttons, thin arrows from short labels and the text on the side. It opens as a window step by
     step (right after the update from the banner, and by «Как пользоваться» in the section — data-guide) and as a page
     in «Настройки» → «Обновление». Screenshots and boxes: tools/guide-shots/run.js. */
  var GUIDES = (window.GUIDES || []).slice().sort(function (a, b) { return verCmp(b.version, a.version); });
  var GUIDE_BOXES = window.GUIDE_BOXES || {};
  function verCmp(a, b) {
    var x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
    for (var i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); }
    return 0;
  }
  // A guide is new in `version` (its section appeared) or, with `updated`, re-shot for the version where the section
  // changed a lot. After an update from `from` to `v` the banner offers a guide that became new or changed in between
  // (a skipped version counts too): a new section first, else a changed one.
  function guideFresh(x, v, from) { return !!x && verCmp(x, v) <= 0 && (!from || verCmp(x, from) > 0); }
  function guideByVersion(v, from) {
    return GUIDES.find(function (g) { return guideFresh(g.version, v, from); }) || GUIDES.find(function (g) { return guideFresh(g.updated, v, from); }) || null;
  }
  function guideVer(g) { return g.updated ? "Обновлено в " + g.updated : "Новое в " + g.version; }
  function guideOfSection(section) { return GUIDES.find(function (g) { return g.section === section; }) || null; }
  // The number of the first point of a frame: points are numbered through the whole step.
  function guideStart(step, fi) { var n = 1; for (var i = 0; i < fi; i++) n += step.frames[i].points.length; return n; }
  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) { var el = document.createElementNS(SVGNS, tag); Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); }); return el; }
  // A screenshot with frames around the boxes, a thin bent arrow from every label to its frame, and the labels.
  // active: the number of the point to stress (the others go pale), or null.
  function guideShot(g, frame, active, n0) {
    var boxes = (GUIDE_BOXES[g.version] || {})[frame.shot] || {};
    var wrap = h("div", { class: "gd-shot" }, h("img", { src: "guides/" + g.version + "/" + frame.shot + ".webp", alt: "", draggable: "false" }));
    var svg = svgEl("svg", { viewBox: "0 0 1280 820", preserveAspectRatio: "none", "aria-hidden": "true" });
    var marker = svgEl("marker", { id: "gd-ah", viewBox: "0 0 10 10", refX: "8.5", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
    marker.append(svgEl("path", { d: "M0,0 L10,5 L0,10 z", class: "gd-head" }));
    var defs = svgEl("defs", {}); defs.append(marker); svg.append(defs);
    frame.points.forEach(function (p, i) {
      var b = boxes[p.box], n = n0 + i, pale = active != null && active !== n;
      if (!b) return;
      var x = b[0] - 5, y = b[1] - 5, w = b[2] + 10, hh = b[3] + 10;
      svg.append(svgEl("rect", { x: x, y: y, width: w, height: hh, rx: 9, class: "gd-frame" + (pale ? " pale" : "") }));
      var tx = Math.max(x, Math.min(p.at[0], x + w)), ty = Math.max(y, Math.min(p.at[1], y + hh));
      if (tx === p.at[0] && ty === p.at[1]) ty = y + hh;
      var mx = (p.at[0] + tx) / 2 + (ty - p.at[1]) * 0.15, my = (p.at[1] + ty) / 2 - (tx - p.at[0]) * 0.15;
      svg.append(svgEl("path", { d: "M" + p.at[0] + "," + p.at[1] + " Q" + mx + "," + my + " " + tx + "," + ty, class: "gd-arrow" + (pale ? " pale" : ""), "marker-end": "url(#gd-ah)" }));
      var lbl = h("span", { class: "gd-lbl" + (pale ? " pale" : "") }, h("b", { text: String(n) }), p.label);
      lbl.style.left = (p.at[0] / 12.8) + "%";
      lbl.style.top = (p.at[1] / 8.2) + "%";
      wrap.append(lbl);
    });
    wrap.insertBefore(svg, wrap.children[1]);
    return wrap;
  }
  // The numbered points of a frame; hovering one stresses its frame on the screenshot.
  function guidePoints(frame, n0, onHover) {
    return h("ol", { class: "gd-pts" }, frame.points.map(function (p, i) {
      return h("li", { onmouseenter: function () { onHover(n0 + i); }, onmouseleave: function () { onHover(null); } },
        h("b", { text: String(n0 + i), "aria-hidden": "true" }), h("span", null, h("strong", { text: p.label }), p.text));
    }));
  }

  // The window, one step at a time.
  var gd = { guide: null, step: 0, frame: 0, dlg: null };
  function openGuide(g, step) {
    if (!g) return;
    gd.guide = g; gd.step = step || 0; gd.frame = 0;
    if (!gd.dlg) {
      gd.dlg = h("dialog", { class: "guide-dlg", "aria-label": "Как пользоваться" });
      gd.dlg.addEventListener("click", function (e) { if (e.target === gd.dlg) gd.dlg.close(); });
      gd.dlg.addEventListener("keydown", function (e) {
        if (e.key === "ArrowRight") { e.preventDefault(); guideGo(1); } else if (e.key === "ArrowLeft") { e.preventDefault(); guideGo(-1); }
      });
      document.body.append(gd.dlg);
    }
    renderGuide();
    if (!gd.dlg.open) gd.dlg.showModal();
  }
  function guideGo(d) {
    var g = gd.guide, step = g.steps[gd.step], s = gd.step, f = gd.frame + d;
    if (f < 0) { s--; f = s >= 0 ? g.steps[s].frames.length - 1 : 0; }
    else if (f >= step.frames.length) { s++; f = 0; }
    if (s < 0 || s >= g.steps.length) return;
    gd.step = s; gd.frame = f; renderGuide();
  }
  function renderGuide() {
    var g = gd.guide, step = g.steps[gd.step], frame = step.frames[gd.frame], n0 = guideStart(step, gd.frame);
    var last = gd.step === g.steps.length - 1 && gd.frame === step.frames.length - 1, first = gd.step === 0 && gd.frame === 0;
    var pic = h("div", { class: "gd-pic" }, guideShot(g, frame, null, n0));
    var hover = function (n) { pic.replaceChildren(guideShot(g, frame, n, n0)); };
    gd.dlg.replaceChildren(
      h("div", { class: "gd-head-row" }, h("h2", { text: "Как пользоваться: " + g.title }), h("span", { class: "gd-ver", text: guideVer(g) }),
        h("button", { type: "button", class: "gd-x", title: "Закрыть (Esc)", "aria-label": "Закрыть", html: ICONS.x, onclick: function () { gd.dlg.close(); } })),
      h("div", { class: "gd-body" }, pic,
        h("div", { class: "gd-side" }, h("h3", { text: (gd.step + 1) + ". " + step.title }), h("p", { class: "gd-lead", text: step.lead }),
          step.frames.length > 1 ? h("div", { class: "gd-frames" }, step.frames.map(function (f, i) {
            return h("button", { type: "button", "aria-pressed": String(i === gd.frame), onclick: function () { gd.frame = i; renderGuide(); } }, f.name);
          })) : null,
          guidePoints(frame, n0, hover))),
      h("div", { class: "gd-foot" },
        h("div", { class: "gd-dots" }, g.steps.map(function (x, i) {
          return h("button", { type: "button", class: i === gd.step ? "on" : "", title: (i + 1) + ". " + x.title, "aria-label": "Шаг " + (i + 1) + ": " + x.title,
            onclick: function () { gd.step = i; gd.frame = 0; renderGuide(); } });
        })),
        h("span", { class: "gd-count", text: "Шаг " + (gd.step + 1) + " из " + g.steps.length }),
        h("button", { type: "button", class: "btn btn-ghost", disabled: first ? "disabled" : null, onclick: function () { guideGo(-1); } }, "Назад"),
        // The guide of the macOS theme has no section of its own: its last button opens «Тема» in the profile menu;
        // the guide of the folded sidebar just closes; «Скиллы» open on the «Промты» page.
        last ? h("button", { type: "button", class: "btn btn-primary", onclick: function () {
          gd.dlg.close(); if (els.settingsDlg.open) els.settingsDlg.close();
          if (g.section === "theme") { setMenu(true); openSub("theme", true); } else if (g.section === "skills") openSkills(); else if (g.section !== "sidebar") setPage(g.section);
        } }, g.section === "theme" ? "Открыть меню «Тема»" : g.section === "sidebar" ? "Понятно" : g.section === "skills" ? "Открыть «Скиллы»" : "Открыть раздел «" + g.title + "»")
          : h("button", { type: "button", class: "btn btn-primary", onclick: function () { guideGo(1); } }, "Дальше")));
  }
  // Delegation also covers guide buttons in sections mounted after the app starts.
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-guide]');
    if (!button) return;
    if (els.menu.contains(button)) setMenu(false);   // «Тема › macOS › Как пользоваться»
    var g = guideOfSection(button.dataset.guide); if (g) openGuide(g);
  });
  api.onCaptureGuide(function () { var g = guideOfSection('screenshots'); if (g) openGuide(g); });

  // While a dialog is open the page is darkened, but the Windows buttons (minimise, maximise, close) are drawn by the system
  // above it: main.js gives them the same shade.
  var controlsDimmed = null;
  function syncControlsShade() {
    var on = !!document.querySelector("dialog:modal");
    if (on === controlsDimmed) return;
    controlsDimmed = on;
    api.dimControls(on);
  }
  new MutationObserver(syncControlsShade).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"], childList: true });
  syncControlsShade();

  // The page in «Настройки» → «Обновление»: the guides of this version and the earlier ones, each folded until opened
  // (the newest one is open); a screenshot is drawn only when its guide is unfolded.
  var guidesPageFor = null;
  function renderGuidesPage() {
    var box = $("upd-guides"), cur = upd.current || "";
    var list = GUIDES.filter(function (g) { return !cur || verCmp(g.version, cur) <= 0; });
    var key = list.map(function (g) { return g.version; }).join(",");
    if (!box || guidesPageFor === key) return;
    guidesPageFor = key;
    box.replaceChildren.apply(box, list.map(function (g, gi) {
      var det = h("details", { class: "gd-page", open: gi === 0 ? "open" : null },
        h("summary", null, "Как пользоваться: " + g.title, h("span", { class: "gd-ver", text: g.updated ? "обновлено в " + g.updated : g.version })));
      var fill = function () {
        if (det.dataset.filled) return;
        det.dataset.filled = "1";
        det.append(
          h("div", { class: "gd-page-top" }, h("p", { class: "tr-hint", text: "Все шаги на одной странице. Цифры на картинках совпадают с пунктами рядом с ними." }),
            h("button", { type: "button", class: "btn-mini", onclick: function () { openGuide(g); } }, "Открыть по шагам")),
          h("div", { class: "gd-toc" }, g.steps.map(function (s, si) {
            return h("button", { type: "button", onclick: function () { var t = det.querySelector('[data-step="' + si + '"]'); if (t) t.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" }); } }, (si + 1) + ". " + s.title);
          })));
        g.steps.forEach(function (s, si) {
          var sec = h("section", { class: "gd-sec", "data-step": String(si) }, h("h4", null, h("i", { text: String(si + 1) }), s.title), h("p", { class: "gd-lead", text: s.lead }));
          s.frames.forEach(function (f, fi) {
            var n0 = guideStart(s, fi), pic = h("div", { class: "gd-sec-pic" }, guideShot(g, f, null, n0));
            if (s.frames.length > 1) sec.append(h("p", { class: "gd-frame-name", text: f.name }));
            sec.append(h("div", { class: "gd-row" }, pic, guidePoints(f, n0, function (n) { pic.replaceChildren(guideShot(g, f, n, n0)); })));
          });
          det.append(sec);
        });
      };
      if (gi === 0) fill();
      det.addEventListener("toggle", function () { if (det.open) fill(); });
      return det;
    }));
  }

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
    if (els.viewer.open || els.profileDlg.open || els.calDialog.open || els.settingsDlg.open || document.querySelector("dialog.guide-dlg[open]")) return;
    var mod = e.ctrlKey || e.metaKey;
    // Tabs like in a browser, and the small assistant window.
    if (isSolo() && mod && !e.shiftKey && !e.altKey && e.code === "KeyW") { e.preventDefault(); window.close(); return; }
    if (isSolo() && mod && (e.code === "Tab" || e.code === "KeyT")) { e.preventDefault(); return; }
    if (mod && !e.altKey && e.code === "Tab") {
      e.preventDefault();
      if (tabs.list.length > 1) activateTab((tabs.active + (e.shiftKey ? -1 : 1) + tabs.list.length) % tabs.list.length);
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.code === "KeyT") { e.preventDefault(); setTabMenu(true); return; }
    if (mod && !e.shiftKey && !e.altKey && e.code === "KeyW") { e.preventDefault(); closeTab(tabs.active); return; }
    if (mod && !e.shiftKey && !e.altKey && e.code === "KeyK") { e.preventDefault(); setQuick(els.qa.hidden); return; }
    if (mod && !e.shiftKey && !e.altKey && e.code === "Comma") { e.preventDefault(); openSettings(); return; }
    if (mod && !e.shiftKey && !e.altKey && e.code === "KeyB" && !isSolo()) { e.preventDefault(); toggleSide(); return; }
    if (mod && !e.shiftKey && !e.altKey && (e.code === "KeyN")) {
      e.preventDefault();
      setPage("prompts");
      if (state.lib === "skills") { if (!sk.draft) pickSkill(); }
      else if (!state.editorOpen) openEditor(null); else els.fTitle.focus();
    }
    else if (mod && !e.shiftKey && !e.altKey && (e.code === "KeyF")) {
      e.preventDefault();
      setPage("prompts");
      if (state.lib === "skills") { if (!skEls.toolbar.hidden) { skEls.search.focus(); skEls.search.select(); } }
      else if (!els.toolbar.hidden) { els.search.focus(); els.search.select(); }
    }
    else if (e.key === "Escape" && document.activeElement === skEls.search && skEls.search.value) {
      skEls.search.value = ""; sk.query = ""; render();
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
  // Another window changed something: show the same here.
  api.timer("state").then(function (r) { if (r && r.timer) applyTimer(r.timer); }, function () {});
  api.onSync(function (d) {
    applyData(d);
    if (d.chats) { hist.list = d.chats; renderHistory(); }
    if (d.transcripts) {
      tr.list = d.transcripts;
      // Deleted or corrected in another window: show it the same here.
      if (tr.open && !tr.list.some(function (x) { return x.id === tr.open.id; })) tr.open = null;
      else if (tr.open) trOpenFresh(tr.open.id);
    }
    render();
  });
  api.onDataChanged(function (prompts) {
    setItems(prompts);
    render();
    toast("Промты обновились из папки");
  });
  call(api.load()).then(function (r) {
    state.loaded = true;
    restoreTabs(r && r.info && r.info.tabs);
    if (!r) return;
    if (isMainWindow && state.profile && !state.profile.welcomed) openProfile(true);
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
