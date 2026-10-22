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

  var state = {
    loaded: false,
    items: [],
    info: null,
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
    banner: $("banner"), bannerText: $("banner-text"), bannerClose: $("banner-close"),
    editorSlot: $("editor-slot"), editor: $("editor"), editorTitle: $("editor-title"),
    fTitle: $("f-title"), fCat: $("f-cat"), fText: $("f-text"), fFiles: $("f-files"),
    saveBtn: $("save-btn"), cancelBtn: $("cancel-btn"), formMsg: $("form-msg"),
    toolbar: $("toolbar"), search: $("search"), filters: $("filters"),
    table: $("table"), rows: $("rows"), stateBox: $("state"), dirLine: $("dir-line"), toast: $("toast"),
    viewer: $("viewer"), viewerTitle: $("viewer-title"), viewerBody: $("viewer-body"),
    viewerOpen: $("viewer-open"), viewerShow: $("viewer-show"), viewerClose: $("viewer-close")
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
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>'
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
      item.files.some(function (f) { return norm(f.name).indexOf(q) !== -1; });
  }
  function findItem(id) { return state.items.find(function (i) { return i.id === id; }) || null; }

  var toastTimer = null;
  function toast(msg, long) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove("show"); }, long ? 5200 : 2400);
  }
  function showBanner(text) {
    els.bannerText.textContent = text;
    els.banner.hidden = false;
  }

  /* ---------- talking to the disk ---------- */
  function setItems(prompts) {
    state.items = (prompts || []).map(function (p) {
      return {
        id: p.id, title: p.title || "", type: p.type || "", text: p.text || "",
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
    api.copyText(item.text).then(function (r) {
      if (r && r.ok) markCopied(btn);
      else toast("Не получилось скопировать. Выделите текст и нажмите Ctrl + C.");
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

  function openEditor(item) {
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
    (item ? els.fText : els.fTitle).focus({ preventScroll: true });
  }
  function snapshot() { return JSON.stringify([els.fTitle.value, els.fText.value, selectedCategory()]); }
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
      item: { id: existing ? existing.id : newId(), title: title, type: type, text: text },
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
    var attach = h("button", { type: "button", class: "btn-mini", title: "Прикрепить файлы к этому промту", onclick: function () { pickForPrompt(item); } },
      icon("clip"), h("span", { text: "Файл" }));
    var copy = h("button", {
      type: "button", class: "btn-mini copy", "aria-label": "Копировать промт «" + item.title + "»",
      onclick: function (e) { copyPrompt(item, e.currentTarget); }
    }, icon("copy"), h("span", { class: "lbl", text: "Копировать" }));
    var count = item.text.length;
    var files = item.files.length ? h("div", { class: "files" }, item.files.map(function (f) { return rowTile(item, f); })) : null;
    return h("div", { class: "prompt" }, box,
      h("div", { class: "prompt-bar" }, toggle,
        h("span", { class: "chars", text: fmtNum(count) + " " + plural(count, "символ", "символа", "символов") }),
        h("span", { class: "spacer" }), attach, copy),
      files);
  }

  function row(item) {
    if (item.id === state.editingId) {
      return h("tr", { class: "editing", "data-id": item.id }, h("td", { colspan: "3", id: "edit-cell" }));
    }
    return h("tr", { "data-id": item.id, class: state.dropRowId === item.id ? "drop-target" : null },
      h("td", { class: "c-name" },
        h("div", { class: "name", text: item.title || "Без названия" }),
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
  }
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
    if (a === "open-dir") call(api.openDataDir());
    else if (a === "change-dir") {
      if (editorDirty()) { toast("Сначала сохраните или отмените правку промта."); return; }
      call(api.changeDataDir()).then(function (r) {
        if (!r || r.canceled) return;
        if (state.editorOpen) closeEditor(false);
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
    }
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
  els.bannerClose.addEventListener("click", function () { els.banner.hidden = true; });
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
    if (els.viewer.open) return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.code === "KeyN")) { e.preventDefault(); if (!state.editorOpen) openEditor(null); else els.fTitle.focus(); }
    else if (mod && !e.shiftKey && !e.altKey && (e.code === "KeyF")) {
      e.preventDefault();
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
    var n = r.notice;
    if (!n) return;
    if (n.kind === "created") toast("Создал папку «Snowball.ai» в Документах. Там хранятся все промты и файлы.", true);
    else if (n.kind === "renamed") toast("Папка с данными теперь называется «Snowball.ai». Все промты и файлы на месте.", true);
    else if (n.kind === "rename-later") showBanner("Промты на месте, но папку в Документах пока не получилось переименовать: она открыта в другой программе. Закройте Проводник и перезапустите программу, папка переименуется сама.");
    else if (n.kind === "restored") showBanner("Файл с промтами оказался повреждён, поэтому я открыл последнюю сохранённую копию. Повреждённый файл лежит рядом, в той же папке.");
    else if (n.kind === "reset") showBanner("Файл с промтами оказался повреждён, а резервной копии нет. Повреждённый файл лежит в той же папке с именем prompts.broken-….json.");
    else if (n.kind === "missing") showBanner("Папка " + n.dir + " недоступна, поэтому я открыл папку в Документах. Если это был съёмный диск, подключите его и выберите папку снова через меню «⋯».");
  });
})();
