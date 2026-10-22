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
  var ACTIONS = ["created", "edited", "files", "copied"];
  var MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  var MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  var WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];

  var state = {
    loaded: false,
    page: "prompts",      // a key of els.views: "prompts", "skills", "calendar", "assistant", "stats", "settings"
    items: [],
    info: null,
    profile: null,        // { name, welcomed, avatar }
    activity: null,       // { since, days: { "2026-10-22": { created, edited, files, copied } } }
    query: "",
    type: "all",
    expanded: new Set(),
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
    table: $("table"), rows: $("rows"), stateBox: $("state"), dirLine: $("dir-line"), toast: $("toast"),
    viewer: $("viewer"), viewerTitle: $("viewer-title"), viewerBody: $("viewer-body"),
    viewerOpen: $("viewer-open"), viewerShow: $("viewer-show"), viewerClose: $("viewer-close"),
    navItems: Array.prototype.slice.call(document.querySelectorAll(".nav-item[data-page]")),
    views: {
      prompts: $("view-prompts"), skills: $("view-skills"), calendar: $("view-calendar"), assistant: $("view-assistant"),
      stats: $("view-stats"), settings: $("view-settings")
    },
    sideAvatar: $("side-avatar"), sideName: $("side-name"),
    menuAvatar: $("menu-avatar"), menuName: $("menu-name"), menuSub: $("menu-sub"),
    statsAvatar: $("stats-avatar"), statsName: $("stats-name"), statsSince: $("stats-since"), statsEdit: $("stats-edit"),
    metrics: $("metrics"), heat: $("heat"), heatTip: $("heat-tip"), breakdown: $("breakdown"),
    settingsVersion: $("settings-version"),
    chat: $("chat"), chatEmpty: $("chat-empty"), chatIdeas: $("chat-ideas"), chatNew: $("chat-new"),
    composer: $("composer"), chatInput: $("chat-input"), chatSend: $("chat-send"),
    chatMode: $("chat-mode"), chatMeta: $("chat-meta"), chatConnect: $("chat-connect"),
    chatHistory: $("chat-history"), chatHistoryBtn: $("chat-history-btn"), chatList: $("chat-list"),
    modelBtn: $("model-btn"), modelBtnText: $("model-btn-text"), modelMenu: $("model-menu"),
    setStatus: $("set-status"), setKeyForm: $("set-key-form"), setKey: $("set-key"), setCheck: $("set-check"),
    setDelete: $("set-delete"), setMsg: $("set-msg"),
    profileDlg: $("profile-dlg"), pdForm: $("pd-form"), pdTitle: $("pd-title"), pdText: $("pd-text"),
    pdAvatar: $("pd-avatar"), pdPick: $("pd-pick"), pdRemove: $("pd-remove"), pdName: $("pd-name"),
    pdSave: $("pd-save"), pdCancel: $("pd-cancel"), pdMsg: $("pd-msg")
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
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9.5L15.5 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z"/><path d="M15.5 20.5V16a.5.5 0 0 1 .5-.5h4.5M7.5 9h9M7.5 12.5h6"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5-5.5-2L10 9Z"/></svg>'
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
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove("show"); }, long ? 5200 : 2400);
  }
  // action: optional { label, onclick } for a button next to the text, { close, onclose } for the close link.
  var bannerOnClose = null;
  function showBanner(text, action) {
    els.bannerText.textContent = text;
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
  // Every call returns { ok, prompts?, error? }. Fresh prompts replace the list.
  function call(promise) {
    return Promise.resolve(promise).then(function (r) {
      if (!r || !r.ok) {
        toast((r && r.error) || "Не получилось. Попробуйте ещё раз.", true);
        return null;
      }
      if (r.prompts) setItems(r.prompts);
      if (r.info) state.info = r.info;
      if (r.profile) state.profile = r.profile;
      if (r.activity) state.activity = r.activity;
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
    var comment = item.comment ? h("div", { class: "prompt-note" }, icon("note"), h("div", { class: "prompt-note-text", text: item.comment })) : null;
    return h("div", { class: "prompt" }, box, comment,
      h("div", { class: "prompt-bar" }, toggle,
        h("span", { class: "chars", text: fmtNum(count) + " " + plural(count, "символ", "символа", "символов") }),
        h("span", { class: "spacer" }), note, attach, copy),
      files);
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
      els.dirLine.replaceChildren("Промты и файлы хранятся в папке ", h("code", { text: state.info.dataDir }), " ",
        h("button", { type: "button", class: "link-btn", onclick: function () { call(api.openDataDir()); } }, "Открыть"),
        state.info.version ? " · Версия " + state.info.version : "");
      markTheme(state.info.theme);
      els.settingsVersion.textContent = state.info.version ? "Версия " + state.info.version : "";
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
  }

  /* ---------- pages and sidebar ---------- */
  function setPage(page) {
    setMenu(false);
    if (state.page === page) return;
    state.page = page;
    els.scroller.scrollTop = 0;
    render();
    if (page === "assistant") { scrollChat(); els.chatInput.focus({ preventScroll: true }); }
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
  }

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
      chip("Прикреплено файлов", s.by.files), chip("Скопировано", s.by.copied));
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
    if (open) { var f = els.menu.querySelector("button"); if (f) f.focus(); }
  }
  els.menuBtn.addEventListener("click", function () { setMenu(els.menu.hidden); });
  document.addEventListener("mousedown", function (e) {
    if (!els.menu.hidden && !els.menu.contains(e.target) && !els.menuBtn.contains(e.target)) setMenu(false);
  });
  els.menu.addEventListener("keydown", function (e) {
    var items = Array.prototype.slice.call(els.menu.querySelectorAll("button"));
    var i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); setMenu(false); els.menuBtn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
  function markTheme(theme) {
    els.menu.querySelectorAll("button[data-theme]").forEach(function (b) {
      b.setAttribute("aria-checked", String(b.dataset.theme === (theme || "system")));
    });
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
    else if (a === "settings") setPage("settings");
    else if (a === "open-dir") call(api.openDataDir());
    else if (a === "change-dir") {
      if (editorDirty()) { toast("Сначала сохраните или отмените правку промта."); return; }
      call(api.changeDataDir()).then(function (r) {
        if (!r || r.canceled) return;
        if (state.editorOpen) closeEditor(false);
        // Conversations live in the data folder too: show the ones from the new folder.
        api.assistantReset();
        clearChat();
        refreshChats();
        state.expanded.clear();
        tileCache.clear();
        render();
        if (r.mode === "copied") showBanner("Промты и файлы скопированы в новую папку. Старая папка осталась на месте: " + r.oldDir + ". Её можно удалить, когда убедитесь, что всё на месте.");
        else toast("Открыл промты из выбранной папки", true);
      });
    } else if (a === "export") {
      call(api.exportJson()).then(function (r) {
        if (!r || r.canceled) return;
        toast("Сохранено: " + r.count + " " + plural(r.count, "промт", "промта", "промтов") + ". Прикреплённые файлы в этот файл не входят.", true);
      });
    } else if (a === "import") {
      call(api.importJson()).then(function (r) {
        if (!r || r.canceled) return;
        render();
        if (r.added) toast("Добавлено: " + r.added + " " + plural(r.added, "промт", "промта", "промтов") + (r.skipped ? ". Уже были в таблице: " + r.skipped : ""), true);
        else toast("Новых промтов в файле нет: все уже есть в таблице", true);
      });
    } else if (a === "check-updates") {
      call(api.checkUpdates()).then(function (r) { if (r) toast("Проверяю обновления…"); });
    }
  });

  /* ---------- updates ---------- */
  // A new version is downloaded only after the user presses "Скачать".
  var upd = { dismissed: null, progressHidden: false };
  function startDownload(version) {
    call(api.downloadUpdate()).then(function (r) {
      if (!r) return;
      upd.progressHidden = false;
      showUpdateProgress(version, 0);
    });
  }
  function showUpdateProgress(version, percent) {
    if (upd.progressHidden) return;
    showBanner("Скачиваю Snowball.ai " + version + "… " + percent + "%. Можно продолжать работать, программа сообщит, когда всё будет готово.", {
      close: "Скрыть", onclose: function () { upd.progressHidden = true; }
    });
  }
  api.onUpdate(function (u) {
    if (u.kind === "available") {
      // The background check asks once per version; "Проверить обновления" always asks.
      if (!u.manual && upd.dismissed === u.version) return;
      showBanner("Вышла новая версия Snowball.ai " + u.version + ". Скачать её? Это займёт около минуты, а установится она после перезапуска.", {
        label: "Скачать",
        close: "Не сейчас",
        onclick: function () { startDownload(u.version); },
        onclose: function () { upd.dismissed = u.version; }
      });
    }
    else if (u.kind === "progress") showUpdateProgress(u.version, u.percent);
    else if (u.kind === "download-error") {
      showBanner("Не получилось скачать Snowball.ai " + u.version + ". Проверьте интернет и попробуйте ещё раз.", {
        label: "Попробовать ещё раз", close: "Не сейчас", onclick: function () { startDownload(u.version); }
      });
    }
    else if (u.kind === "latest") toast("У вас последняя версия", true);
    else if (u.kind === "error") toast("Не получилось проверить обновления. Проверьте интернет.", true);
    else if (u.kind === "ready") {
      showBanner("Скачана новая версия Snowball.ai " + u.version + ". Перезапустите программу, чтобы её установить. Если не сейчас, она установится сама, когда вы закроете программу.", {
        label: "Перезапустить и обновить",
        close: "Позже",
        onclick: function () {
          if (editorDirty()) { toast("Сначала сохраните или отмените правку промта."); return; }
          call(api.installUpdate());
        }
      });
    }
  });

  /* ---------- assistant ---------- */
  // The open conversation lives here; after every finished message it is saved to chats.json (the "История" list).
  // main.js gets the whole conversation on every message and streams the answer back through api.onAssistant.
  var IDEAS = ["Добавь промт «Неоновый город»", "Улучши промт: кот в космосе", "Поставь созвон на завтра в 15:00", "Сколько у меня промтов?"];
  var LIST_RE = /^\s*([-*•]|\d+[.)])\s+/;
  var chat = {
    id: null,           // null until the first message: an empty "Новый разговор" is not saved
    title: "",
    list: [],           // saved conversations for the history list: { id, title, createdAt, updatedAt }
    confirmId: null,    // the history item asking "Удалить разговор?"
    messages: [],       // { role: "user" | "assistant", text, el, body?, extra?, foot?, actions?, streaming?, note?, failed? }
    streamId: null,     // the answer being written now
    current: null,      // its message
    waiting: false,     // sent, but main.js has not said the stream id yet
    early: []           // events that came before the id
  };

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

  function nearBottom() { var s = els.scroller; return s.scrollHeight - s.scrollTop - s.clientHeight < 90; }
  function scrollChat() {
    if (state.page !== "assistant") return;
    els.scroller.scrollTop = els.scroller.scrollHeight;
  }
  // Keeps the newest text in view, unless the user scrolled up to read something.
  function follow(fn) {
    var stick = nearBottom();
    fn();
    if (stick) scrollChat();
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
    msg.foot.replaceChildren.apply(msg.foot, kids);
    msg.foot.hidden = !kids.length;
  }

  function actionCard(msg, a) {
    var cat = categoryOf(a.category);
    var kids = [
      h("div", { class: "act-head" }, icon("spark"), h("span", { text: "Создать промт «" + a.title + "»?" })),
      h("div", { class: "act-meta" }, h("span", { class: "chip " + catClass(a.category) }, cat ? cat.label : a.category || "Без типа")),
      h("div", { class: "act-text", text: a.text })
    ];
    if (a.status === "done") {
      kids.push(h("div", { class: "act-done" }, icon("check"), h("span", { text: "Промт сохранён в таблицу" }),
        h("button", { type: "button", class: "link-btn", onclick: function () { setPage("prompts"); } }, "Открыть «Промты»")));
    } else if (a.status === "canceled") {
      kids.push(h("div", { class: "act-done off" }, h("span", { text: "Отменено, ничего не сохранено" })));
    } else if (a.status === "stale") {
      kids.push(h("div", { class: "act-done off" }, h("span", { text: "Карточка устарела. Попросите ассистента ещё раз, если промт нужен" })));
    } else {
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
  function decide(msg, a, accept) {
    if (a.status) return;
    a.status = "busy";
    renderActions(msg);
    call(api.assistantDecide(a.id, accept)).then(function (r) {
      a.status = r ? (accept ? "done" : "canceled") : null;
      if (r && accept) { render(); toast("Промт «" + a.title + "» добавлен"); }
      renderActions(msg);
      persist();
    });
  }

  function addMessage(role, text) {
    els.chatEmpty.hidden = true;
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
    chat.messages.push(msg);
    els.chat.append(msg.el);
    return msg;
  }

  function setBusy(busy) {
    els.composer.classList.toggle("busy", busy);
    els.chatSend.setAttribute("aria-label", busy ? "Остановить ответ" : "Отправить");
    els.chatSend.title = els.chatSend.getAttribute("aria-label");
  }
  function finish(msg, note, failed) {
    msg.streaming = false;
    msg.note = note || "";
    msg.failed = !!failed;
    if (chat.current === msg) { chat.current = null; chat.streamId = null; }
    renderBody(msg);
    renderFoot(msg);
    setBusy(false);
    persist();
  }

  // What main.js gets: finished messages only, without the empty answers that failed or were stopped at once.
  function history() {
    return chat.messages.filter(function (m) { return m.text && !m.streaming; }).map(function (m) { return { role: m.role, content: m.text }; });
  }
  function startReply() {
    var msg = addMessage("assistant", "");
    msg.streaming = true;
    renderBody(msg);
    chat.current = msg;
    chat.streamId = null;
    chat.waiting = true;
    chat.early = [];
    setBusy(true);
    scrollChat();
    api.assistantSend(history()).then(function (r) {
      chat.waiting = false;
      if (chat.current !== msg) return;
      if (!r || !r.ok) { finish(msg, (r && r.error) || "Ассистент не ответил. Попробуйте ещё раз.", true); return; }
      chat.streamId = r.id;
      var early = chat.early;
      chat.early = [];
      early.forEach(onAssistantEvent);
    }, function () {
      chat.waiting = false;
      if (chat.current === msg) finish(msg, "Ассистент не ответил. Попробуйте ещё раз.", true);
    });
  }
  function sendChat(text) {
    text = String(text || "").replace(/\s+$/, "");
    if (!text.trim() || chat.current) return;
    if (!chat.id) {
      chat.id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      chat.title = text.trim().replace(/\s+/g, " ").slice(0, 70);
    }
    addMessage("user", text);
    persist();
    els.chatInput.value = "";
    growInput();
    startReply();
  }
  function stopChat() {
    var msg = chat.current;
    if (!msg) return;
    if (chat.streamId) api.assistantStop(chat.streamId);
    finish(msg, "Ответ остановлен");
  }
  function retry(msg) {
    var i = chat.messages.indexOf(msg);
    if (i === -1 || chat.current) return;
    chat.messages.splice(i, 1);
    msg.el.remove();
    startReply();
  }
  /* ---------- history ---------- */
  // The conversation as it is saved: text and what the user answered on cards, no page elements.
  function savedMessages() {
    return chat.messages.filter(function (m) { return !m.streaming && (m.text || m.note || (m.actions && m.actions.length)); }).map(function (m) {
      var out = { role: m.role, text: m.text };
      if (m.note) out.note = m.note;
      if (m.failed) out.failed = true;
      if (m.actions && m.actions.length) out.actions = m.actions.map(function (a) {
        return { id: a.id, kind: a.kind, title: a.title, category: a.category, text: a.text, status: a.status === "busy" ? null : a.status };
      });
      return out;
    });
  }
  function persist() {
    if (!chat.id) return;
    var messages = savedMessages();
    if (!messages.length) return;
    api.chatSave({ id: chat.id, title: chat.title, messages: messages }).then(function (r) {
      if (r && r.ok) { chat.list = r.chats; renderHistory(); }
    }, function () {});
  }
  // Before opening another conversation: stop the answer and turn unanswered cards into "устарела"
  // (main.js forgets them on assistantReset).
  function leaveChat() {
    if (chat.current) stopChat();
    chat.messages.forEach(function (m) {
      (m.actions || []).forEach(function (a) { if (!a.status || a.status === "busy") a.status = "stale"; });
    });
    persist();
    api.assistantReset();
  }
  function clearChat() {
    chat.id = null;
    chat.title = "";
    chat.messages = [];
    chat.current = null;
    chat.streamId = null;
    chat.waiting = false;
    chat.early = [];
    els.chat.replaceChildren(els.chatEmpty);
    els.chatEmpty.hidden = false;
    setBusy(false);
  }
  function newChat() {
    leaveChat();
    clearChat();
    els.chatInput.value = "";
    growInput();
    renderHistory();
    setHistoryOpen(false);
    els.scroller.scrollTop = 0;
    els.chatInput.focus();
  }
  function openChat(id) {
    if (id === chat.id) { setHistoryOpen(false); return; }
    leaveChat();
    api.chatGet(id).then(function (r) {
      if (!r || !r.ok) { toast((r && r.error) || "Не получилось открыть разговор."); return; }
      clearChat();
      chat.id = r.chat.id;
      chat.title = r.chat.title;
      r.chat.messages.forEach(function (m) {
        var msg = addMessage(m.role, m.text);
        if (m.role !== "assistant") return;
        msg.note = m.note || "";
        msg.failed = !!m.failed;
        msg.actions = (m.actions || []).map(function (a) { return Object.assign({}, a); });
        renderBody(msg);
        renderActions(msg);
        renderFoot(msg);
      });
      renderHistory();
      setHistoryOpen(false);
      scrollChat();
      els.chatInput.focus({ preventScroll: true });
    });
  }
  function removeChat(id) {
    api.chatDelete(id).then(function (r) {
      chat.confirmId = null;
      if (r && r.ok) chat.list = r.chats;
      if (id === chat.id) { api.assistantReset(); clearChat(); }
      renderHistory();
      toast("Разговор удалён");
    }, function () { toast("Не получилось удалить разговор."); });
  }
  function historyItem(c) {
    if (chat.confirmId === c.id) {
      return h("div", { class: "ch-item confirm" },
        h("span", { text: "Удалить разговор?" }),
        h("button", { type: "button", class: "link-btn danger", onclick: function () { removeChat(c.id); } }, "Удалить"),
        h("button", { type: "button", class: "link-btn", onclick: function () { chat.confirmId = null; renderHistory(); } }, "Отмена"));
    }
    return h("div", { class: "ch-item" },
      h("button", { type: "button", class: "ch-open", "aria-current": c.id === chat.id ? "true" : null, title: c.title, onclick: function () { openChat(c.id); } },
        h("span", { class: "ch-name", text: c.title }), h("span", { class: "ch-when", text: fmtWhen(c.updatedAt) })),
      h("button", { type: "button", class: "ch-del", "aria-label": "Удалить разговор «" + c.title + "»", title: "Удалить разговор", html: ICONS.x,
        onclick: function () { chat.confirmId = c.id; renderHistory(); } }));
  }
  function renderHistory() {
    var kids = chat.list.map(historyItem);
    if (!kids.length) kids = [h("p", { class: "ch-empty", text: "Здесь появятся ваши разговоры с ассистентом." })];
    els.chatList.replaceChildren.apply(els.chatList, kids);
  }
  // In a narrow window the history hides behind the "История" button.
  function setHistoryOpen(open) {
    els.chatHistory.classList.toggle("open", open);
    els.chatHistoryBtn.setAttribute("aria-expanded", String(open));
  }
  function refreshChats() {
    api.chatList().then(function (r) { if (r && r.ok) { chat.list = r.chats; renderHistory(); } }, function () {});
  }

  function onAssistantEvent(e) {
    if (!e) return;
    if (chat.waiting && chat.current) { chat.early.push(e); return; }
    var msg = chat.current;
    if (!msg || e.id !== chat.streamId) return;   // an answer that was stopped or belongs to an old conversation
    follow(function () {
      if (e.kind === "delta") { msg.text += e.text || ""; renderBody(msg); }
      else if (e.kind === "action" && e.action) { msg.actions.push(Object.assign({ status: null }, e.action)); renderActions(msg); }
      else if (e.kind === "done") finish(msg);
      else if (e.kind === "error") finish(msg, e.error || "Ассистент не ответил. Попробуйте ещё раз.", true);
    });
  }
  api.onAssistant(onAssistantEvent);

  function growInput() {
    var t = els.chatInput;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight + 2, 220) + "px";
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

  /* ---------- assistant settings ---------- */
  // The key itself never comes back from main.js: the page only knows whether one is saved.
  var MODELS = [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", short: "Opus 5.5", text: "Основная: лучше всего пишет и улучшает промты" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", short: "Haiku 5.5", text: "Быстрая и примерно в 40 раз дешевле Opus" }
  ];
  // How long Claude thinks before answering (effort in the API). Deeper is slower and costs more.
  var EFFORTS = [
    { id: "low", name: "Быстро", text: "Отвечает сразу, почти не раздумывая. Дешевле всего" },
    { id: "medium", name: "Средне", text: "Подходит для большинства задач" },
    { id: "high", name: "Глубоко", text: "Дольше думает: для сложных промтов и разборов" },
    { id: "xhigh", name: "Очень глубоко", text: "Ещё дольше и дороже" },
    { id: "max", name: "Максимум", text: "Думает, сколько нужно. Самый медленный и дорогой" }
  ];
  function byId(list, id) { return list.find(function (x) { return x.id === id; }) || null; }
  function renderAssistantSettings() {
    var a = state.info && state.info.assistant;
    if (!a) return;
    var model = byId(MODELS, a.model), effort = byId(EFFORTS, a.effort);
    els.chatMode.hidden = a.hasKey;
    els.chatMeta.hidden = !a.hasKey;
    els.chatMeta.textContent = a.hasKey ? "Отвечает " + (model ? model.name : a.model) + "." : "";
    els.modelBtnText.textContent = (model ? model.short : a.model) + " · " + (effort ? effort.name : a.effort);
    if (!els.modelMenu.hidden) renderModelMenu();
    els.setStatus.textContent = a.hasKey ? "Ключ сохранён" : "Ключа нет, отвечает заглушка";
    els.setStatus.classList.toggle("on", a.hasKey);
    els.setDelete.hidden = !a.hasKey;
    els.setKey.placeholder = a.hasKey ? "Ключ сохранён. Вставьте новый, чтобы заменить" : "sk-ant-…";
  }

  /* ---------- "Модель" button in the message box ---------- */
  function modelOption(kind, item, checked) {
    return h("button", { type: "button", class: "mm-item", role: "menuitemradio", "aria-checked": String(checked),
      onclick: function () { pickOption(kind, item); } },
      h("span", { class: "mm-text" }, h("span", { class: "mm-name", text: item.name }), h("span", { class: "mm-sub", text: item.text })),
      h("span", { class: "mm-tick", html: ICONS.check, "aria-hidden": "true" }));
  }
  function renderModelMenu() {
    var a = (state.info && state.info.assistant) || {};
    var kids = [];
    if (!a.hasKey) {
      kids.push(h("div", { class: "mm-note" }, "Сейчас отвечает заглушка, выбор заработает с ключом Claude. ",
        h("button", { type: "button", class: "link-btn", onclick: function () { setModelMenu(false); setPage("settings"); els.setKey.focus(); } }, "Подключить")));
    }
    kids.push(h("div", { class: "mm-label", text: "Модель" }));
    MODELS.forEach(function (m) { kids.push(modelOption("model", m, m.id === a.model)); });
    kids.push(h("hr"), h("div", { class: "mm-label", text: "Размышления" }));
    EFFORTS.forEach(function (e) { kids.push(modelOption("effort", e, e.id === a.effort)); });
    els.modelMenu.replaceChildren.apply(els.modelMenu, kids);
  }
  function setModelMenu(open) {
    if (open) renderModelMenu();
    els.modelMenu.hidden = !open;
    els.modelBtn.setAttribute("aria-expanded", String(open));
    if (open) { var c = els.modelMenu.querySelector('[aria-checked="true"]') || els.modelMenu.querySelector(".mm-item"); if (c) c.focus(); }
  }
  // The menu stays open, so model and thinking can be picked one after the other, like in Claude.
  function pickOption(kind, item) {
    var opts = {};
    opts[kind] = item.id;
    call(api.assistantSetOptions(opts)).then(function (r) {
      if (!r) return;
      renderAssistantSettings();
      renderModelMenu();
      var f = els.modelMenu.querySelectorAll(".mm-item");
      for (var i = 0; i < f.length; i++) if (f[i].querySelector(".mm-name").textContent === item.name) f[i].focus();
    });
  }
  els.modelBtn.addEventListener("click", function () { setModelMenu(els.modelMenu.hidden); });
  document.addEventListener("mousedown", function (e) {
    if (!els.modelMenu.hidden && !els.modelMenu.contains(e.target) && !els.modelBtn.contains(e.target)) setModelMenu(false);
  });
  els.modelMenu.addEventListener("keydown", function (e) {
    var items = Array.prototype.slice.call(els.modelMenu.querySelectorAll(".mm-item"));
    var i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setModelMenu(false); els.modelBtn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
  function setKeyMsg(text, neutral) {
    els.setMsg.textContent = text || "";
    els.setMsg.classList.toggle("neutral", !!neutral);
  }
  els.setKeyForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (els.setCheck.disabled) return;
    var key = els.setKey.value.trim();
    var a = state.info && state.info.assistant;
    if (!key && !(a && a.hasKey)) { setKeyMsg("Вставьте ключ в поле."); els.setKey.focus(); return; }
    els.setCheck.disabled = true;
    setKeyMsg("Проверяю ключ, это займёт пару секунд…", true);
    api.assistantCheckKey(key).then(function (r) {
      els.setCheck.disabled = false;
      if (!r || !r.ok) { setKeyMsg((r && r.error) || "Не получилось проверить ключ. Попробуйте ещё раз."); return; }
      state.info = r.info;
      els.setKey.value = "";
      render();
      if (r.warning) setKeyMsg((r.saved ? "Ключ сохранён, но " : "Ключ верный, но ") + r.warning.charAt(0).toLowerCase() + r.warning.slice(1));
      else setKeyMsg(r.saved ? "Ключ работает и сохранён. Теперь в «Ассистенте» отвечает Claude." : "Ключ работает.", true);
    }, function () {
      els.setCheck.disabled = false;
      setKeyMsg("Не получилось проверить ключ. Попробуйте ещё раз.");
    });
  });
  els.setDelete.addEventListener("click", function () {
    call(api.assistantDeleteKey()).then(function (r) {
      if (!r) return;
      render();
      setKeyMsg("Ключ удалён. Ассистент снова отвечает заглушкой.", true);
    });
  });
  els.setKey.addEventListener("input", function () { if (els.setMsg.textContent) setKeyMsg(""); });
  els.chatConnect.addEventListener("click", function () { setPage("settings"); els.setKey.focus(); });

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
    if (els.viewer.open || els.profileDlg.open) return;
    var mod = e.ctrlKey || e.metaKey;
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
  if (api.platform === "win32") els.titlebar.hidden = false;
  render();
  api.onDataChanged(function (prompts) {
    setItems(prompts);
    render();
    toast("Промты обновились из папки");
  });
  call(api.load()).then(function (r) {
    state.loaded = true;
    render();
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
