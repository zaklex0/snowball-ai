'use strict';
window.screenshotEditor = window.SnowCapture.mount(
  document.getElementById('screenshots-root'),
  window.vsApi,
  new URLSearchParams(location.search).get('id'),
);
