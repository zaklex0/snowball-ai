'use strict';
// Run with Electron against a built app.asar, without starting the real app or touching its shortcuts.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
(async () => {
  await app.whenReady();
  const selected = process.argv.find((arg) => arg.startsWith('--archive='));
  const archive = selected ? path.resolve(selected.slice('--archive='.length)) : path.resolve(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(archive, 'src', 'capture-editor.html'));
  const wav = Buffer.alloc(44 + 16000 * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  const result = await win.webContents.executeJavaScript(`(async()=>{
    await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='transcription-stream.js';s.onload=resolve;s.onerror=reject;document.body.append(s)});
    const binary=atob(${JSON.stringify(wav.toString('base64'))}), bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
    const api={mediaReadRange:async(file,token,start,end)=>({ok:true,data:bytes.slice(start,end).buffer})};
    const reader=await transcriptionStream.open({file:'test.wav',token:'test',size:bytes.length},api);
    try {const levels=await reader.scan(null,()=>false),audio=await reader.wav(0,0.5);return levels.length>30&&audio.byteLength===16044;}
    finally {reader.close()}
  })()`);
  if (!result) throw new Error('Packaged decoder did not read the test audio.');
  const marker = process.argv.find((arg) => arg.startsWith('--marker='));
  if (marker) fs.writeFileSync(path.resolve(marker.slice('--marker='.length)), JSON.stringify({ ok: true }));
  console.log('OK: packaged audio reader and decoder load from app.asar');
  app.quit();
})().catch((e) => { console.error(e); app.exit(1); });
