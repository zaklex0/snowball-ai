'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnowTaskBoard = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // One canonical order for the board, numbers and assistant tools. Filters never renumber tasks.
  function numberedTasks(tasks, columns, groups) {
    const columnRank = new Map(columns.map((c, i) => [c.id, i]));
    const groupRank = new Map(groups.map((g, i) => [g.id, i]));
    const rank = t => groupRank.has(t.groupId) ? groupRank.get(t.groupId) : groups.length;
    const sorted = tasks.slice().sort((a, b) => (columnRank.get(a.status) || 0) - (columnRank.get(b.status) || 0) ||
      Number(!!a.archivedAt) - Number(!!b.archivedAt) || rank(a) - rank(b) || a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const byId = new Map(sorted.map(t => [t.id, t]));
    function parent(t) {
      const p = byId.get(t.parentId);
      if (!p || p.status !== t.status || !!p.archivedAt !== !!t.archivedAt || p.groupId !== t.groupId) return null;
      const seen = new Set([t.id]); let node = p;
      while (node) { if (seen.has(node.id)) return null; seen.add(node.id); node = byId.get(node.parentId); }
      return p;
    }
    const counters = new Map(), children = new Map(), numbers = new Map();
    sorted.forEach(t => { const p = parent(t); if (p) { if (!children.has(p.id)) children.set(p.id, []); children.get(p.id).push(t); } });
    function assign(t, number) {
      numbers.set(t.id, number);
      (children.get(t.id) || []).forEach((child, i) => assign(child, String(number) + '.' + (i + 1)));
    }
    sorted.filter(t => !parent(t)).forEach(t => {
      const scope = t.status + ':' + !!t.archivedAt, n = (counters.get(scope) || 0) + 1;
      counters.set(scope, n); assign(t, n);
    });
    return sorted.map(t => ({ ...t, number: numbers.get(t.id), numberScope: t.archivedAt ? 'archive' : 'board' }));
  }
  return { numberedTasks };
});
