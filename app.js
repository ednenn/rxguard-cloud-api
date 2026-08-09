import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { URL } from 'node:url';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const BACKUPS = path.join(ROOT, 'backups');
const RUNTIME = path.join(ROOT, 'runtime');
for (const d of [PUBLIC, DATA, BACKUPS, RUNTIME]) fs.mkdirSync(d, { recursive: true });

function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 8787);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Degistir123!';
const SESSION_SECRET = process.env.SESSION_SECRET || 'rxguard-change-this-secret';
const SITE_FILE = path.join(PUBLIC, 'index.html');
const DRAFT_FILE = path.join(RUNTIME, 'draft.json');
const HISTORY_FILE = path.join(DATA, 'history.json');
const DRUG_FILE = path.join(DATA, 'drugs.json');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const RULES_FILE = path.join(DATA, 'rules.json');
const USERS_FILE = path.join(DATA, 'users.json');

for (const [p, init] of [
  [HISTORY_FILE, []], [DRUG_FILE, []], [SETTINGS_FILE, { appName: 'RxGuard AI' }], [RULES_FILE, []], [USERS_FILE, []]
]) if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(init, null, 2));

function json(res, data, status = 200, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(data));
}
function html(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function text(res, body, status = 200, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body);
}
function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('İstek çok büyük')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseCookies(req) {
  const out = {};
  for (const p of String(req.headers.cookie || '').split(';')) {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
function b64url(s) { return Buffer.from(s).toString('base64url'); }
function sign(s) { return crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url'); }
function issueSession() {
  const payload = JSON.stringify({ exp: Date.now() + 7 * 86400_000, nonce: crypto.randomBytes(8).toString('hex') });
  const p = b64url(payload); return `${p}.${sign(p)}`;
}
function isAdmin(req) {
  const tok = parseCookies(req).rxg_session; if (!tok) return false;
  const [p, s] = tok.split('.'); if (!p || !s || sign(p) !== s) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')).exp > Date.now(); } catch { return false; }
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, user) {
  try {
    const h = crypto.scryptSync(String(password), String(user.salt), 64);
    const expected = Buffer.from(String(user.passwordHash), 'hex');
    return h.length === expected.length && crypto.timingSafeEqual(h, expected);
  } catch { return false; }
}
function issueUserSession(user) {
  const payload = JSON.stringify({ exp: Date.now() + 30 * 86400_000, userId: user.id, email: user.email, nonce: crypto.randomBytes(8).toString('hex') });
  const p = b64url(payload); return `${p}.${sign('user:' + p)}`;
}
function getUserSession(req) {
  const tok = parseCookies(req).rxg_user; if (!tok) return null;
  const [p, s] = tok.split('.'); if (!p || !s || sign('user:' + p) !== s) return null;
  try {
    const data = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (data.exp <= Date.now()) return null;
    const users = safeReadJson(USERS_FILE, []);
    return users.find(x => x.id === data.userId) || null;
  } catch { return null; }
}
function publicUser(user) {
  return user ? { id:user.id, email:user.email, name:user.name || '', createdAt:user.createdAt } : null;
}

function safeReadJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, value) { fs.writeFileSync(p, JSON.stringify(value, null, 2)); }

const PROTECTED = new Set([
  'supervisor.js', '.env', '.env.example', 'Dockerfile', 'docker-compose.yml', 'package.json',
  'android/gradle.properties'
]);
const EDITABLE_PREFIXES = ['app.js', 'public/', 'data/', 'android/', '.github/workflows/'];
function allowedPath(rel) {
  rel = rel.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..') || PROTECTED.has(rel)) return false;
  return EDITABLE_PREFIXES.some(p => p.endsWith('/') ? rel.startsWith(p) : rel === p);
}
function projectSnapshot() {
  const files = [];
  function walk(dir, base='') {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.posix.join(base, ent.name);
      if (rel.startsWith('backups/') || rel.startsWith('runtime/') || rel.startsWith('android/.gradle/') || rel.startsWith('android/app/build/') || rel === '.env' || rel === 'supervisor.js') continue;
      const abs = path.join(ROOT, rel);
      if (ent.isDirectory()) walk(abs, rel);
      else if (allowedPath(rel)) {
        const buf = fs.readFileSync(abs);
        if (buf.length <= 500_000) files.push({ path: rel, content: buf.toString('utf8') });
      }
    }
  }
  walk(ROOT);
  return files;
}
function createBackup(label='AI değişikliği öncesi') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUPS, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const files = projectSnapshot();
  for (const f of files) {
    const dst = path.join(dir, f.path); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, f.content);
  }
  writeJson(path.join(dir, 'manifest.json'), { createdAt: new Date().toISOString(), label, files: files.map(x => x.path) });
  const h = safeReadJson(HISTORY_FILE, []); h.unshift({ id: stamp, label, createdAt: new Date().toISOString() }); writeJson(HISTORY_FILE, h.slice(0, 50));
  return dir;
}
function validateOperations(ops) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('AI dosya değişikliği üretmedi.');
  for (const op of ops) {
    if (!['write', 'delete'].includes(op.action)) throw new Error('Geçersiz işlem: ' + op.action);
    if (!allowedPath(String(op.path || ''))) throw new Error('Korunan/geçersiz dosya: ' + op.path);
    if (op.action === 'write' && typeof op.content !== 'string') throw new Error('Dosya içeriği eksik: ' + op.path);
  }
}
function validateStaged(ops) {
  const tmp = fs.mkdtempSync(path.join(RUNTIME, 'stage-'));
  try {
    for (const f of projectSnapshot()) { const dst = path.join(tmp, f.path); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, f.content); }
    for (const op of ops) {
      const dst = path.join(tmp, op.path);
      if (op.action === 'delete') fs.rmSync(dst, { force: true, recursive: true });
      else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, op.content); }
    }
    for (const op of ops.filter(x => x.action === 'write' && x.path.endsWith('.js'))) {
      const r = spawnSync(process.execPath, ['--check', path.join(tmp, op.path)], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`JavaScript kontrolü başarısız (${op.path}): ${r.stderr || r.stdout}`);
    }
    if (!fs.existsSync(path.join(tmp, 'public/index.html'))) throw new Error('public/index.html silinemez.');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
function applyOperations(ops) {
  for (const op of ops) {
    const dst = path.join(ROOT, op.path);
    if (op.action === 'delete') fs.rmSync(dst, { force: true, recursive: true });
    else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, op.content); }
  }
}


function githubConfig() {
  const repo = String(process.env.GITHUB_REPO || '').trim(); // ör: ednenn/RxGuard-Standalone
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const branch = String(process.env.GITHUB_BRANCH || 'main').trim();
  return { repo, token, branch, configured: !!repo && !!token };
}
async function gh(pathname, options={}) {
  const cfg = githubConfig();
  if (!cfg.configured) throw new Error('GitHub entegrasyonu ayarlı değil. GITHUB_REPO ve GITHUB_TOKEN gerekli.');
  const r = await fetch('https://api.github.com' + pathname, {
    ...options,
    headers: {
      'accept':'application/vnd.github+json',
      'authorization':`Bearer ${cfg.token}`,
      'x-github-api-version':'2022-11-28',
      'user-agent':'RxGuard-AI-Developer',
      ...(options.headers||{})
    }
  });
  const raw = await r.text();
  let data={}; try { data=raw?JSON.parse(raw):{} } catch {}
  if(!r.ok) throw new Error(`GitHub HTTP ${r.status}: ${data.message||raw.slice(0,300)}`);
  return data;
}
async function pushOperationsToGitHub(ops, message) {
  const cfg = githubConfig();
  if (!cfg.configured) return { pushed:false, reason:'GitHub entegrasyonu ayarlı değil.' };

  const ref = await gh(`/repos/${cfg.repo}/git/ref/heads/${encodeURIComponent(cfg.branch)}`);
  const parentSha = ref.object.sha;
  const parentCommit = await gh(`/repos/${cfg.repo}/git/commits/${parentSha}`);
  const treeEntries = [];

  for (const op of ops) {
    const rel = String(op.path).replaceAll('\\','/').replace(/^\/+/,'');
    if (op.action === 'delete') {
      treeEntries.push({path:rel, mode:'100644', type:'blob', sha:null});
      continue;
    }
    const blob = await gh(`/repos/${cfg.repo}/git/blobs`, {
      method:'POST',
      body:JSON.stringify({content:op.content, encoding:'utf-8'})
    });
    treeEntries.push({path:rel, mode:'100644', type:'blob', sha:blob.sha});
  }

  const tree = await gh(`/repos/${cfg.repo}/git/trees`, {
    method:'POST',
    body:JSON.stringify({base_tree:parentCommit.tree.sha, tree:treeEntries})
  });
  const commit = await gh(`/repos/${cfg.repo}/git/commits`, {
    method:'POST',
    body:JSON.stringify({
      message: String(message||'RxGuard AI Geliştirici güncellemesi').slice(0,200),
      tree: tree.sha,
      parents:[parentSha]
    })
  });
  await gh(`/repos/${cfg.repo}/git/refs/heads/${encodeURIComponent(cfg.branch)}`, {
    method:'PATCH',
    body:JSON.stringify({sha:commit.sha, force:false})
  });
  return {pushed:true, commit:commit.sha, branch:cfg.branch, repo:cfg.repo};
}

async function callAI(command) {
  const base = String(process.env.AI_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.AI_API_KEY || '';
  const model = process.env.AI_MODEL || '';
  if (!base || !model) throw new Error('AI_BASE_URL ve AI_MODEL .env dosyasında ayarlanmalı.');
  const files = projectSnapshot();
  const compact = files.map(f => `\n--- FILE: ${f.path} ---\n${f.content}`).join('');
  const system = `Sen RxGuard uygulamasının kıdemli full-stack geliştiricisisin. Kullanıcının Türkçe komutunu mevcut projeye uygula.\nYalnızca STRICT JSON döndür. Şema: {"summary":"Türkçe kısa özet","restart":true|false,"operations":[{"action":"write|delete","path":"...","content":"tam dosya içeriği"}]}.\nSadece değişen dosyaları operations içine koy. Kısmi patch değil, write işleminde TAM dosya içeriği ver.\nİzinli alanlar: app.js, public/*, data/*. Korunan dosyalar ve secretlar değiştirilemez.\nMevcut faydalı özellikleri istemedikçe silme. Mobil uyum, yönetici girişi, yedek/geri alma ve AI geliştirici erişimini koru.\nBackend değişirse restart=true yap. Harici bağımlılık ekleme; Node built-in modüllerini kullan.\nKullanıcı komutu: ${command}\n\nPROJE:${compact}`;
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: command }], temperature: 0.1, response_format: { type: 'json_object' } };
  const headers = { 'content-type': 'application/json' }; if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  const raw = await r.text(); if (!r.ok) throw new Error(`AI HTTP ${r.status}: ${raw.slice(0, 500)}`);
  let payload; try { payload = JSON.parse(raw); } catch { throw new Error('AI yanıtı JSON değil.'); }
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI boş yanıt verdi.');
  let out; try { out = JSON.parse(content); } catch {
    const m = String(content).match(/\{[\s\S]*\}/); if (!m) throw new Error('AI geçerli proje planı üretmedi.'); out = JSON.parse(m[0]);
  }
  validateOperations(out.operations);
  validateStaged(out.operations);
  return { summary: String(out.summary || command).slice(0, 500), restart: !!out.restart, operations: out.operations };
}

function injectAdmin(htmlText) {
  if (htmlText.includes('id="rxg-dev-launcher"')) return htmlText;
  const ui = `\n<style id="rxg-dev-style">#rxg-dev-launcher{position:static;z-index:2147483000;border:0;border-radius:999px;padding:13px 17px;background:#6b35c8;color:#fff;font-weight:800;box-shadow:0 8px 28px #0004;cursor:pointer}#rxg-dev-modal{display:none;position:fixed;inset:0;z-index:2147483001;background:#071b2ddd;padding:14px;overflow:auto;font-family:Segoe UI,Arial,sans-serif}#rxg-dev-box{max-width:1000px;margin:18px auto;background:#fff;color:#102b43;border-radius:18px;padding:18px}#rxg-dev-box textarea,#rxg-dev-box input{width:100%;padding:12px;border:1px solid #b9c7d2;border-radius:10px;font:inherit}#rxg-dev-box textarea{min-height:130px}.rxg-row{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:9px}.rxg-b{border:0;border-radius:10px;padding:12px;font-weight:800;color:#fff;background:#1768ad;cursor:pointer}.rxg-p{background:#6b35c8}.rxg-r{background:#a52c36}.rxg-g{background:#526a7e}#rxg-status{white-space:pre-wrap;margin-top:10px;padding:10px;background:#eef3f7;border-radius:10px}#rxg-ops{white-space:pre-wrap;max-height:330px;overflow:auto;background:#0e1b27;color:#e7f2fa;padding:12px;border-radius:10px;margin-top:10px;font:12px Consolas,monospace}@media(max-width:650px){.rxg-row{grid-template-columns:1fr}}</style>\n<button id="rxg-dev-launcher" onclick="rxgDevOpen()">🤖 AI Geliştirici</button>\n<div id="rxg-dev-modal"><div id="rxg-dev-box"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><div><b style="font-size:22px">🤖 RxGuard AI Geliştirici</b><div>Web + Android + SUT + kurallar + veri kaynaklarını tek yerden değiştir, önizle, yayınla ve geri al.</div></div><button class="rxg-b rxg-g" onclick="rxgDevClose()">KAPAT</button></div><div id="rxg-login" style="margin-top:12px"><input id="rxg-pass" type="password" placeholder="Yönetici şifresi"><button class="rxg-b" style="margin-top:8px" onclick="rxgLogin()">GİRİŞ</button></div><div id="rxg-studio" style="display:none;margin-top:12px"><textarea id="rxg-command" placeholder="Örn: Eczacı ekranına yeni buton ekle; aynı değişikliği Android’e de uygula. / Şu SUT kuralını ekle. / Hasta ekranını sadeleştir."></textarea><div class="rxg-row"><button class="rxg-b rxg-p" onclick="rxgPrepare()">1. HAZIRLA</button><button id="rxg-apply" class="rxg-b" onclick="rxgApply()" disabled>2. ONAYLA VE UYGULA</button><button class="rxg-b rxg-r" onclick="rxgRollback()">GERİ AL</button><button class="rxg-b rxg-g" onclick="rxgStatus()">DURUM</button></div><div id="rxg-status">Hazır.</div><div id="rxg-persist" style="margin-top:8px;font-weight:700"></div><pre id="rxg-ops"></pre></div></div></div>\n<script id="rxg-dev-script">const r$=i=>document.getElementById(i);async function rapi(p,o={}){let r=await fetch(p,{...o,headers:{'content-type':'application/json',...(o.headers||{})}}),t=await r.text(),d={};try{d=JSON.parse(t)}catch{}if(!r.ok)throw new Error(d.error||t||('HTTP '+r.status));return d}function rxgDevOpen(){r$('rxg-dev-modal').style.display='block';rxgSession()}function rxgDevClose(){r$('rxg-dev-modal').style.display='none'}async function rxgSession(){try{let d=await rapi('/api/admin/status');r$('rxg-login').style.display='none';r$('rxg-studio').style.display='block';r$('rxg-persist').textContent=d.githubConfigured?'✅ GitHub bağlı: değişiklikler kalıcı ve WEB + Android birlikte yayınlanır.':'⚠ GitHub bağlı değil: değişiklikler Render yeniden deploy edince kaybolabilir.'}catch{r$('rxg-login').style.display='block';r$('rxg-studio').style.display='none'}}async function rxgLogin(){try{await rapi('/api/admin/login',{method:'POST',body:JSON.stringify({password:r$('rxg-pass').value})});rxgSession()}catch(e){alert(e.message)}}async function rxgPrepare(){let c=r$('rxg-command').value.trim();if(!c)return;r$('rxg-status').textContent='AI projeyi analiz ediyor...';r$('rxg-apply').disabled=true;try{let d=await rapi('/api/admin/prepare',{method:'POST',body:JSON.stringify({command:c})});r$('rxg-status').textContent='TASLAK HAZIR: '+d.summary;r$('rxg-ops').textContent=d.files.join('\\n');r$('rxg-apply').disabled=false}catch(e){r$('rxg-status').textContent='HATA: '+e.message}}async function rxgApply(){if(!confirm('Hazırlanan değişiklik uygulansın mı? Otomatik yedek alınacak.'))return;try{let d=await rapi('/api/admin/apply',{method:'POST',body:'{}'});r$('rxg-status').textContent=d.summary+(d.restarting?'\\nUygulama yeniden başlatılıyor...':'');setTimeout(()=>location.reload(),d.restarting?3500:800)}catch(e){r$('rxg-status').textContent='HATA: '+e.message}}async function rxgRollback(){if(!confirm('Son yedeğe dönülsün mü?'))return;try{let d=await rapi('/api/admin/rollback',{method:'POST',body:'{}'});r$('rxg-status').textContent=d.summary;setTimeout(()=>location.reload(),2500)}catch(e){r$('rxg-status').textContent='HATA: '+e.message}}async function rxgStatus(){try{let d=await rapi('/api/admin/status');r$('rxg-status').textContent='Düzenlenebilir alanlar: '+d.editable.join(', ')+'\nGitHub: '+(d.githubConfigured?'BAĞLI':'BAĞLI DEĞİL')+'\nSürüm: '+d.version}catch(e){r$('rxg-status').textContent='HATA: '+e.message}};(()=>{const b=document.getElementById('rxg-dev-launcher');const t=document.querySelector('.toolbar');if(b&&t){b.style.marginLeft='auto';b.style.borderRadius='7px';b.style.padding='11px 14px';b.style.boxShadow='none';t.appendChild(b)}else if(b){b.style.position='fixed';b.style.right='12px';b.style.top='70px'}})();</script>`;
  return htmlText.replace(/<\/body>/i, ui + '\n</body>');
}

function restoreBackupById(id) {
  const dir = path.join(BACKUPS, id); const manifest = safeReadJson(path.join(dir, 'manifest.json'), null);
  if (!manifest) throw new Error('Yedek bulunamadı.');
  for (const rel of manifest.files || []) {
    const src = path.join(dir, rel), dst = path.join(ROOT, rel);
    if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
  }
}


function normalizeDose(v) {
  const raw = String(v ?? '').trim().toLowerCase().replace(',', '.');
  if (!raw) return null;
  let m = raw.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
  if (m) return Number(m[1]) * Number(m[2]);
  m = raw.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}
function normText(v){return String(v||'').toLocaleLowerCase('tr-TR').replace(/[^a-z0-9çğıöşü]+/gi,' ').trim()}
function ruleMatches(rule, ctx){
  if(!rule || rule.enabled===false) return false;
  const drug=normText(ctx.drug?.name), active=normText(ctx.drug?.activeIngredient), branch=normText(ctx.prescription?.doctorBranch), icd=(ctx.prescription?.icd||[]).map(x=>String(x.code||x)).join(' ').toUpperCase();
  if(rule.drug && !drug.includes(normText(rule.drug))) return false;
  if(rule.activeIngredient && !active.includes(normText(rule.activeIngredient))) return false;
  if(rule.branch && !branch.includes(normText(rule.branch))) return false;
  if(rule.icd && !icd.includes(String(rule.icd).toUpperCase())) return false;
  return true;
}
function applyCustomRules(ctx, current){
  const rules=safeReadJson(RULES_FILE,[]);
  let out={...current};
  const prio={KESINTI:4,DOKTOR_TEYIDI:3,INCELEME:2,UYGUN:1};
  for(const rule of rules){
    if(!ruleMatches(rule,ctx)) continue;
    const st=String(rule.status||'INCELEME').toUpperCase();
    if((prio[st]||0)>=(prio[out.status]||0)) out={status:st,reason:String(rule.message||rule.reason||'Ek kural koşulu uygulandı.')};
  }
  return out;
}
function decideChecks(extracted){
  const rx = Array.isArray(extracted?.prescriptions) ? extracted.prescriptions : [];
  const reports = Array.isArray(extracted?.reports) ? extracted.reports : [];
  const results=[];
  const samePatient=(a,b)=>{const x=normText(a||''), y=normText(b||''); if(!x||!y) return true; return x===y || x.includes(y) || y.includes(x)};
  for(const pr of rx){
    for(const drug of (pr.drugs||[])){
      const dn=normText(drug.activeIngredient||drug.name); let best=null;
      for(const rp of reports){
        if(!samePatient(pr.patientName,rp.patientName)) continue;
        for(const rd of (rp.drugs||[])){const rn=normText(rd.activeIngredient||rd.name); if(dn&&rn&&(dn===rn||dn.includes(rn)||rn.includes(dn))){best={report:rp,drug:rd};break}}
        if(best)break;
      }
      // Manuel şablonda satırdaki reportDose doğrudan kullanılabilir.
      if(!best && drug.reportDose){best={report:{patientName:pr.patientName},drug:{dose:drug.reportDose,name:drug.name,activeIngredient:drug.activeIngredient}}}
      const rxDose=normalizeDose(drug.usage), reportDose=normalizeDose(best?.drug?.dose);
      let status='UYGUN', reason='Tamamdır. Mevcut kurallarda ödeme engeli bulunmadı.';
      if(best && rxDose!=null && reportDose!=null){
        if(rxDose>reportDose){status='KESINTI';reason=`ÖDENMEZ: Reçete dozu (${drug.usage}) rapor dozundan (${best.drug.dose}) yüksek.`}
        else if(rxDose<reportDose){status='DOKTOR_TEYIDI';reason=`DOKTOR TEYİDİ: Reçete dozu (${drug.usage}) rapor dozundan (${best.drug.dose}) düşük.`}
        else reason='TAMAMDIR: Reçete ve rapor dozu uyumlu.';
      } else if(best){ status='INCELEME'; reason='İNCELENECEK: Rapor eşleşti ancak doz güvenilir okunamadı.'; }
      else { status='INCELEME'; reason='İNCELENECEK: Bu ilaç için henüz SUT/özel kural tanımlı değil veya eşleşen rapor yok.'; }
      const custom=applyCustomRules({prescription:pr,drug,report:best?.report,reportDrug:best?.drug},{status,reason}); status=custom.status;reason=custom.reason;
      results.push({prescriptionNo:pr.prescriptionNo||'',patientName:pr.patientName||'',drugName:drug.name||'',barcode:drug.barcode||'',activeIngredient:drug.activeIngredient||'',usage:drug.usage||'',boxCount:drug.boxCount||'',reportDose:best?.drug?.dose||drug.reportDose||'',status,reason});
    }
  }
  const priority={KESINTI:4,DOKTOR_TEYIDI:3,INCELEME:2,UYGUN:1};
  const overall=results.length?results.reduce((a,b)=>priority[b.status]>priority[a]?b.status:a,'UYGUN'):'INCELEME';
  return {overall,results};
}
function checkManualPrescription(input){
  const prescription=input?.prescription||{};
  const reports=Array.isArray(input?.reports)?input.reports:[];
  return decideChecks({prescriptions:[prescription],reports});
}

function cleanJsonText(v){
  let t=String(v||'').trim();
  t=t.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  const a=t.indexOf('{'), b=t.lastIndexOf('}');
  if(a>=0 && b>a) t=t.slice(a,b+1);
  return t;
}
async function callVisionOne(image, index){
  const base=String(process.env.AI_BASE_URL||'').replace(/\/$/,'');
  const key=process.env.AI_API_KEY||'';
  const model=String(process.env.VISION_MODEL||'qwen/qwen3.6-27b').trim()||'qwen/qwen3.6-27b';
  if(!base||!key) throw new Error('AI bağlantısı ayarlı değil.');
  if(!/^data:image\/(jpeg|png|webp);base64,/i.test(image)) throw new Error('Desteklenmeyen görüntü biçimi.');
  const prompt=`Bu görüntü Türkiye SGK/Medula sisteminden alınmış veya kağıt/ekran üzerinden taranmış bir sağlık belgesidir.
ÖNCE BELGE TÜRÜNÜ AYIR:
- RAPOR: "Rapor Bilgileri", "Rapor Takip No", "Rapor Tarihi", "Etkin Madde Bilgileri", "Rapor Tanıları", rapor başlangıç/bitiş tarihi gibi rapora özgü başlıklar baskınsa RAPOR.
- RECETE: "Reçete No", "Reçete Tarihi", "Doktor", "İlaçlar", barkod/kutu/kullanım satırları baskınsa RECETE.
- Emin değilsen BILINMIYOR. Bir raporu asla sırf içinde ilaç adı var diye reçete sayma.

Görüntü telefon dikey/yatay tutulmuş olabilir; zihinsel olarak döndür. Perspektif, parlama ve ekran çekimini tolere et.
Alanları ETİKETLERİNE göre eşleştir; komşu alanların değerlerini birbirine kaydırma. Okunmayan alanı boş bırak, uydurma yapma.
Hasta cinsiyeti, yaş/doğum tarihi, hastane/tesis, doktor adı ve doktor branşını ayrı ayrı çıkarmaya özellikle dikkat et.
SADECE JSON nesnesi döndür.
Şema:
{"imageIndex":${index},"type":"RECETE|RAPOR|BILINMIYOR","confidence":0.0,
"patientName":"","patientGender":"","patientAge":"","patientBirthDate":"",
"doctorName":"","doctorBranch":"","hospital":"","facilityCode":"",
"date":"","prescriptionNo":"","reportNo":"","reportStartDate":"","reportEndDate":"",
"icd":[{"code":"","description":""}],"warnings":[],
"drugs":[{"name":"","barcode":"","activeIngredient":"","usage":"","boxCount":"","dose":""}],
"rawText":"kısa okunabilir özet"}.
RECETE belgesinde usage reçete kullanım dozu; RAPOR belgesinde dose rapor dozu olsun. İlaç/etken madde satırlarını ayrı ayrı çıkar.`
  const messages=[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:image}}]}];
  const attempts=[
    {model,messages,temperature:0.1,max_completion_tokens:3000,reasoning_effort:'none'},
    {model,messages,temperature:0.2,max_completion_tokens:3000}
  ];
  let last='';
  for(const body of attempts){
    const r=await fetch(base+'/chat/completions',{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${key}`},body:JSON.stringify(body)});
    const raw=await r.text();
    if(!r.ok){last=`HTTP ${r.status}: ${raw.slice(0,450)}`;continue}
    let payload; try{payload=JSON.parse(raw)}catch{last='AI cevabı paket JSON değil.';continue}
    const c=payload?.choices?.[0]?.message?.content;
    if(!c){last='AI boş yanıt verdi.';continue}
    try{return JSON.parse(cleanJsonText(c))}catch{last='AI belge JSON çıktısı çözülemedi: '+String(c).slice(0,220)}
  }
  throw new Error(`Belge ${index+1} okunamadı: ${last}`);
}
async function analyzeDocumentImages(images){
  if(!Array.isArray(images)||!images.length) throw new Error('Belge görüntüsü yok.');
  if(images.length>10) throw new Error('Tek kontrolde en fazla 10 tarama gönderilebilir.');
  const docs=[]; const errors=[];
  for(let i=0;i<images.length;i++){
    try{docs.push(await callVisionOne(images[i],i))}
    catch(e){errors.push(String(e.message||e))}
  }
  if(!docs.length) throw new Error(errors.join(' | ')||'Belgeler okunamadı.');
  const prescriptions=[],reports=[],unknown=[];
  for(const d of docs){
    const t=String(d.type||'').toUpperCase();
    if(t==='RECETE') prescriptions.push(d); else if(t==='RAPOR') reports.push(d); else unknown.push(d);
  }
  const extracted={prescriptions,reports,unknown};
  return {...extracted,errors,check:decideChecks(extracted)};
}

async function api(req, res, u) {
  if (u.pathname === '/api/app/config' && req.method === 'GET') {
    return json(res, {
      ok:true, version:'8.1.0',
      modes:[
        {id:'eczaci',title:'Eczacı',description:'Reçete, rapor, SUT ve kural kontrolü'},
        {id:'saglikci',title:'Sağlıkçı',description:'Klinik ve mesleki ilaç bilgisi'},
        {id:'ogrenci',title:'Öğrenci',description:'Ders ve farmakoloji odaklı açıklamalar'},
        {id:'hasta',title:'Hasta',description:'Kısa ve anlaşılır ilaç bilgisi'}
      ]
    });
  }
  if (u.pathname === '/api/auth/register' && req.method === 'POST') {
    let b={}; try { b=JSON.parse(await readBody(req)); } catch {}
    const email=String(b.email||'').trim().toLowerCase(), password=String(b.password||''), name=String(b.name||'').trim();
    if (!email.includes('@') || password.length < 6) return json(res,{error:'Geçerli e-posta ve en az 6 karakter şifre gerekli.'},400);
    const users=safeReadJson(USERS_FILE,[]);
    if(users.some(x=>x.email===email)) return json(res,{error:'Bu e-posta zaten kayıtlı.'},409);
    const hp=hashPassword(password);
    const user={id:crypto.randomUUID(),email,name,salt:hp.salt,passwordHash:hp.hash,createdAt:new Date().toISOString()};
    users.push(user); writeJson(USERS_FILE,users);
    return json(res,{ok:true,user:publicUser(user)},200,{'set-cookie':`rxg_user=${issueUserSession(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`});
  }
  if (u.pathname === '/api/auth/login' && req.method === 'POST') {
    let b={}; try { b=JSON.parse(await readBody(req)); } catch {}
    const email=String(b.email||'').trim().toLowerCase(), password=String(b.password||'');
    const users=safeReadJson(USERS_FILE,[]), user=users.find(x=>x.email===email);
    if(!user || !verifyPassword(password,user)) return json(res,{error:'E-posta veya şifre hatalı.'},401);
    return json(res,{ok:true,user:publicUser(user)},200,{'set-cookie':`rxg_user=${issueUserSession(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`});
  }
  if (u.pathname === '/api/auth/me' && req.method === 'GET') {
    const user=getUserSession(req); return user ? json(res,{ok:true,user:publicUser(user)}) : json(res,{error:'Oturum yok.'},401);
  }
  if (u.pathname === '/api/auth/logout' && req.method === 'POST') {
    return json(res,{ok:true},200,{'set-cookie':'rxg_user=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'});
  }
  if (u.pathname === '/api/drug/info' && req.method === 'GET') {
    const q=String(u.searchParams.get('q')||'').trim().toLocaleLowerCase('tr-TR');
    if(!q) return json(res,{ok:true,results:[]});
    const list=safeReadJson(DRUG_FILE,[]);
    const results=list.filter(x=>JSON.stringify(x).toLocaleLowerCase('tr-TR').includes(q)).slice(0,20);
    return json(res,{ok:true,results});
  }
  if (u.pathname === '/api/admin/login' && req.method === 'POST') {
    let b={}; try { b=JSON.parse(await readBody(req)); } catch {}
    if (String(b.password || '') !== ADMIN_PASSWORD) return json(res, { error: 'Şifre hatalı.' }, 401);
    return json(res, { ok: true }, 200, { 'set-cookie': `rxg_session=${issueSession()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800` });
  }
  if (u.pathname === '/api/health') return json(res, { ok: true, version: '8.1.0', aiConfigured: !!process.env.AI_BASE_URL && !!process.env.AI_MODEL, visionConfigured: !!process.env.AI_API_KEY });

  if (u.pathname === '/api/mobile/analyze' && req.method === 'POST') {
    let b={}; try { b=JSON.parse(await readBody(req, 28_000_000)); } catch(e) { return json(res,{error:'Geçersiz belge isteği.'},400); }
    const images=Array.isArray(b.images)?b.images:[];
    const result=await analyzeDocumentImages(images);
    return json(res,{ok:true,version:'8.1.0',...result});
  }

  if (u.pathname === '/api/prescription/check' && req.method === 'POST') {
    let b={}; try { b=JSON.parse(await readBody(req, 4_000_000)); } catch(e) { return json(res,{error:'Geçersiz reçete verisi.'},400); }
    const result=checkManualPrescription(b);
    return json(res,{ok:true,version:'8.1.0',check:result});
  }

  if (u.pathname === '/api/rules' && req.method === 'GET') {
    return json(res,{ok:true,rules:safeReadJson(RULES_FILE,[])});
  }
  if (!isAdmin(req)) return json(res, { error: 'Yönetici oturumu gerekli.' }, 401);
  if (u.pathname === '/api/admin/status') {
    const cfg=githubConfig();
    return json(res, { ok:true, version:'8.1.0', githubConfigured:cfg.configured, repo:cfg.repo||'', branch:cfg.branch, editable:EDITABLE_PREFIXES });
  }
  if (u.pathname === '/api/admin/prepare' && req.method === 'POST') {
    const b = JSON.parse(await readBody(req)); const command = String(b.command || '').trim(); if (!command) return json(res, { error: 'Komut boş.' }, 400);
    const draft = await callAI(command); writeJson(DRAFT_FILE, { ...draft, command, createdAt: new Date().toISOString() });
    return json(res, { ok: true, summary: draft.summary, restart: draft.restart, files: draft.operations.map(x => `${x.action.toUpperCase()}  ${x.path}`) });
  }
  if (u.pathname === '/api/admin/apply' && req.method === 'POST') {
    const draft = safeReadJson(DRAFT_FILE, null); if (!draft) return json(res, { error: 'Hazırlanmış taslak yok.' }, 400);
    validateOperations(draft.operations); validateStaged(draft.operations);
    const backupDir = createBackup('AI değişikliği öncesi');

    // Önce GitHub'a tek commit: bu hem Render deploy'u hem Android Actions build'ini tetikler.
    let github={pushed:false};
    try {
      github = await pushOperationsToGitHub(draft.operations, 'RxGuard AI: ' + String(draft.summary||draft.command||'güncelleme'));
    } catch(e) {
      return json(res,{error:'Kalıcı yayınlama başarısız: '+String(e.message||e)},502);
    }

    applyOperations(draft.operations);
    fs.rmSync(DRAFT_FILE, { force: true });
    fs.rmSync(path.join(RUNTIME, 'pending-restart.json'), { force: true });

    const restarting = !!draft.restart && !github.pushed;
    if (restarting) {
      writeJson(path.join(RUNTIME, 'pending-restart.json'), { backupDir, createdAt: Date.now() });
      json(res, { ok:true, restarting:true, github, summary:'Değişiklik yerelde uygulandı. Sunucu yeniden başlatılıyor.' });
      setTimeout(() => process.exit(75), 250);
      return;
    }
    return json(res, {
      ok:true, restarting:!!github.pushed, github,
      summary: github.pushed
        ? 'Değişiklik GitHub’a kalıcı olarak kaydedildi. Render web/sunucuyu, GitHub Actions Android APK’yı aynı committen güncelleyecek.'
        : 'Değişiklik yalnız çalışan sunucuya uygulandı.'
    });
  }
  if (u.pathname === '/api/admin/rollback' && req.method === 'POST') {
    const h = safeReadJson(HISTORY_FILE, []); if (!h.length) return json(res, { error: 'Geri alınacak yedek yok.' }, 400);
    restoreBackupById(h[0].id); writeJson(path.join(RUNTIME, 'pending-restart.json'), { backupDir: path.join(BACKUPS, h[0].id), createdAt: Date.now() });
    json(res, { ok: true, summary: 'Son yedek geri yüklendi. Sunucu yeniden başlatılıyor.' }); setTimeout(() => process.exit(75), 250); return;
  }
  return json(res, { error: 'Bulunamadı.' }, 404);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    if (req.method !== 'GET') return text(res, 'Bulunamadı', 404);
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const body = fs.readFileSync(SITE_FILE, 'utf8'); return html(res, injectAdmin(body));
    }
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (rel.includes('..')) return text(res, 'Geçersiz yol', 400);
    const p = path.join(PUBLIC, rel);
    if (!p.startsWith(PUBLIC) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return text(res, 'Bulunamadı', 404);
    const ext = path.extname(p).toLowerCase(); const types = { '.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(p).pipe(res);
  } catch (e) { console.error(e); json(res, { error: String(e.message || e) }, 500); }
});
server.listen(PORT, '0.0.0.0', () => {
  fs.rmSync(path.join(RUNTIME, 'pending-restart.json'), { force: true });
  console.log(`[RxGuard] http://0.0.0.0:${PORT} hazır`);
});
