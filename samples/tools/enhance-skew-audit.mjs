// Offline audit of the deskew estimator across the WHOLE corpus, zero API cost.
//
// Enhancement runs on every upload, not just angled ones, so the risk that
// matters most is the opposite of the one it was built for: spuriously rotating
// a label that was already straight. A pristine image must estimate ~0.
//
//   node enhance-skew-audit.mjs [--limit=N]
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { enhanceImage } from '../../lib/enhance.ts';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(HERE, '..', 'robustness');
const LIMIT = Number((process.argv.find(a=>a.startsWith('--limit='))||'').split('=')[1]||0);
let files = fs.readdirSync(IMG).filter(f=>/\.png$/.test(f));
if (LIMIT) files = files.slice(0, LIMIT);
const browser = await chromium.launch();
const page = await browser.newPage();
const FN = enhanceImage.toString();
const rows = [];
let i = 0;
for (const f of files) {
  const b64 = fs.readFileSync(path.join(IMG, f)).toString('base64');
  let r = null;
  try {
    r = await page.evaluate(async ({b64,FN}) => {
      const img = new Image(); img.src='data:image/png;base64,'+b64;
      await new Promise(res=>{img.onload=res;img.onerror=res});
      if(!img.naturalWidth) return null;
      const c=document.createElement('canvas'); c.width=img.naturalWidth;c.height=img.naturalHeight;
      const ctx=c.getContext('2d',{willReadFrequently:true}); ctx.drawImage(img,0,0);
      const t0=performance.now();
      const o=eval('('+FN+')')(ctx.getImageData(0,0,c.width,c.height).data,c.width,c.height);
      return {skew:o.skewDeg, ms:Math.round(performance.now()-t0)};
    }, {b64,FN});
  } catch {}
  const [label,cond]=f.replace(/\.png$/,'').split('--');
  rows.push({label,cond:cond??'',skew:r?r.skew:null,ms:r?r.ms:null});
  if(++i%200===0) process.stdout.write(`  ...${i}/${files.length}\n`);
}
await browser.close();
const fam=c=>/^rot/.test(c)?'rotation':/^angle/.test(c)?'angle':/^pristine/.test(c)?'baseline':c.replace(/\d+$/,'');
const by={};
for(const r of rows){ const f=fam(r.cond); (by[f]??=[]).push(r); }
console.log('\nfamily        n   rotated(|skew|>=0.75)   median|skew|   max|skew|');
for(const [f,rs] of Object.entries(by).sort()){
  const s=rs.map(r=>Math.abs(r.skew??0));
  const rot=s.filter(v=>v>=0.75).length;
  const sorted=s.slice().sort((a,b)=>a-b);
  console.log(`${f.padEnd(13)} ${String(rs.length).padStart(3)}   ${String(rot).padStart(4)} (${(100*rot/rs.length).toFixed(0)}%)          ${sorted[sorted.length>>1].toFixed(1)}            ${Math.max(...s).toFixed(1)}`);
}
const base=by.baseline??[];
const badBase=base.filter(r=>Math.abs(r.skew??0)>=0.75);
console.log(`\nPRISTINE FALSE-ROTATION: ${badBase.length}/${base.length}` + (badBase.length?`  -> ${badBase.map(r=>`${r.label}(${r.skew})`).join(' ')}`:'  (none — straight labels are left alone)'));
const ms=rows.map(r=>r.ms).filter(Boolean).sort((a,b)=>a-b);
console.log(`enhance cost: median ${ms[ms.length>>1]}ms, p95 ${ms[Math.floor(ms.length*0.95)]}ms, max ${ms[ms.length-1]}ms`);
fs.writeFileSync(path.join(HERE, '..', '..', 'docs', 'enhance-skew-audit.json'), JSON.stringify({n:rows.length,rows},null,2));
console.log('docs/enhance-skew-audit.json written');
