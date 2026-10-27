'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),{spawn}=require('child_process');
const {connect}=require('./guide-shots/cdp');
const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'snowball-capture-preview-')),profile=path.join(tmp,'profile');
fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({dataDir:path.join(tmp,'data'),theme:'light',tabs:[{kind:'screenshots'}],bounds:{width:1280,height:850}}));
const child=spawn(require('electron'),[root,'--inspect=9244','--remote-debugging-port=9344','--user-data-dir='+profile],{cwd:root,stdio:'ignore',windowsHide:true});
process.on('exit',()=>{try{child.kill();}catch{}});
(async()=>{const main=await connect(9244,t=>t.type==='node');const ud=await main.ev("process.mainModule.require('electron').app.getPath('userData')");if(path.resolve(ud)!==profile)throw Error('Wrong test profile');const page=await connect(9344,t=>t.type==='page'&&/index\.html/.test(t.url));await page.until("!!document.querySelector('.capture-nav')");await page.ev("document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelector('.capture-nav').click();true");await page.sleep(500);const png=await page.send('Page.captureScreenshot',{format:'png'});const out=process.argv[2]||path.join(tmp,'location.png');fs.writeFileSync(out,Buffer.from(png.result.data,'base64'));console.log(out);process.exit(0);})().catch(e=>{console.error(e.message);process.exit(1);});
