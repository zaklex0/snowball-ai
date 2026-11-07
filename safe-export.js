'use strict';
// Write exports beside their destination and replace the destination only after the new file is complete.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

async function replace(source, target) {
  let last;
  for (let i = 0; i < 6; i++) {
    try { await fsp.rename(source, target); return; }
    catch (e) {
      last = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e && e.code)) throw e;
      await new Promise((resolve) => setTimeout(resolve, 80 * (i + 1)));
    }
  }
  throw last;
}

async function writeExport(target, writer) {
  const tmp = path.join(path.dirname(target), '.snowball-export-' + crypto.randomBytes(12).toString('hex') + '.tmp');
  // An existing file is never opened or removed, even if a temporary name happens to collide.
  let handle;
  try { handle = await fsp.open(tmp, 'wx'); }
  catch (e) { e.exportDestination = true; throw e; }
  try {
    await writer(handle);
    await handle.close();
    await replace(tmp, target);
  } catch (e) {
    e.exportDestination = true;
    throw e;
  } finally {
    await handle.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

function exportBytes(target, data) {
  return writeExport(target, (handle) => handle.writeFile(data));
}

function exportFile(source, target) {
  return writeExport(target, (handle) => {
    const input = fs.createReadStream(source);
    input.on('error', (e) => { e.exportSource = path.basename(source); });
    return pipeline(input, handle.createWriteStream());
  });
}

module.exports = { writeExport, exportBytes, exportFile };
