/**
 * ACTUA — Alertes CV Indeed v13
 * npm init -y && npm install playwright && npx playwright install chromium
 * node setup_indeed_alerts.js --agency "Actua BELFORT"
 */

const { chromium } = require('playwright');
const fs       = require('fs');
const readline = require('readline');

const ALERTS_DATA   = JSON.parse(fs.readFileSync('alerts_data.json', 'utf8'));
const DRY_RUN       = process.argv.includes('--dry-run');
const SINGLE_AGENCY = (() => { const i = process.argv.indexOf('--agency'); return i !== -1 ? process.argv[i+1] : null; })();
const LIMIT         = (() => { const i = process.argv.indexOf('--limit');  return i !== -1 ? parseInt(process.argv[i+1]) : null; })();
const FROM          = (() => { const i = process.argv.indexOf('--from');   return i !== -1 ? parseInt(process.argv[i+1]) - 1 : 0; })(); // 1-based

const SALESFORCE_URL          = 'https://indeedinc.lightning.force.com/lightning/n/IndeedAccountSearch';
const RESUMES_URL             = 'https://resumes.indeed.com/?co=FR&hl=fr&prevCo=FR';
const LICENSE_ACCOUNT_PATTERN = /ideuzo for actua/i;

if (!fs.existsSync('screenshots')) fs.mkdirSync('screenshots');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (msg, lvl='info') => {
  const icons = { info:'ℹ️ ', success:'✅', error:'❌', warn:'⚠️ ', step:'  →' };
  console.log(`[${new Date().toLocaleTimeString('fr-FR')}] ${icons[lvl]} ${msg}`);
};
function waitEnter(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, () => { rl.close(); r(); }));
}

// ─── SALESFORCE : attendre auto que la searchbar soit prête ──────────────────

async function waitForSalesforceReady(sfPage) {
  log('Attente Salesforce...', 'step');
  const deadline = Date.now() + 120_000; // 2 min max
  while (Date.now() < deadline) {
    try {
      const ready = await sfPage.evaluate(() => {
        function deepFindAll(root) {
          const r = [];
          root.querySelectorAll('input').forEach(el => r.push(el));
          root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) r.push(...deepFindAll(el.shadowRoot)); });
          return r;
        }
        const inputs = deepFindAll(document);
        return !!inputs.find(i => /email/i.test(i.placeholder) || /resume/i.test(i.placeholder));
      });
      if (ready) { log('Salesforce prêt ✓', 'success'); return; }
    } catch(e) {}
    await sleep(1500);
  }
  throw new Error('Timeout — Salesforce non prêt après 2 min');
}

async function sfFillAndSearch(sfPage, email) {
  log(`Salesforce → ${email}`, 'step');
  await sfPage.goto(SALESFORCE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForSalesforceReady(sfPage);
  await sleep(500);

  await sfPage.evaluate((emailVal) => {
    function deepFindAll(root) {
      const r = [];
      root.querySelectorAll('input').forEach(el => r.push(el));
      root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) r.push(...deepFindAll(el.shadowRoot)); });
      return r;
    }
    const all = deepFindAll(document);
    const t = all.find(i => /email/i.test(i.placeholder) || /resume/i.test(i.placeholder))
           || all.filter(i => i.type !== 'hidden')[1];
    if (!t) throw new Error('Input introuvable');
    t.removeAttribute('tabindex');
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(t, emailVal);
    t.dispatchEvent(new Event('focus',  { bubbles: true }));
    t.dispatchEvent(new Event('input',  { bubbles: true }));
    t.dispatchEvent(new Event('change', { bubbles: true }));
    t.focus();
  }, email);

  log(`Email saisi : ${email}`, 'success');
  await sleep(400);
  await sfPage.keyboard.press('Enter');
  await sleep(4000);
}

// ─── LOGIN AS ADVERTISER ──────────────────────────────────────────────────────

async function clickLoginAsAdvertiser(context, sfPage) {
  log('Clic "Login As Advertiser"...', 'step');
  await sleep(1000);
  const [newPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 20000 }).catch(() => null),
    sfPage.evaluate(() => {
      function deepClick(root) {
        for (const el of root.querySelectorAll('a, button, span')) {
          if (/login\s*as\s*advertiser/i.test(el.textContent || '')) { el.click(); return true; }
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot && deepClick(el.shadowRoot)) return true;
        }
        return false;
      }
      return deepClick(document);
    }),
  ]);
  await sleep(2000);
  const p = newPage || context.pages().find(p => p !== sfPage) || sfPage;
  await p.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  log(`URL : ${p.url().slice(0, 70)}`, 'info');
  return p;
}

// ─── ATTENDRE FIN DU LOGIN (auto, sans ENTRÉE) ───────────────────────────────

// ─── DÉTECTION CAPTCHA ────────────────────────────────────────────────────────
// Surveille en continu si un CAPTCHA apparaît et attend que l'utilisateur le résolve

const isCaptchaPage = url =>
  url.includes('captcha') ||
  url.includes('challenge') ||
  url.includes('recaptcha') ||
  url.includes('arkose') ||
  url.includes('funcaptcha') ||
  url.includes('datadome');

async function waitForCaptchaIfNeeded(page) {
  const url = page.url();
  if (!isCaptchaPage(url)) return;

  log('⚠️  CAPTCHA détecté ! Résous-le dans le navigateur.', 'warn');
  log('Le script reprend automatiquement une fois le CAPTCHA résolu.', 'warn');
  const deadline = Date.now() + 300_000; // 5 min max
  while (Date.now() < deadline) {
    await sleep(1500);
    try {
      const current = page.url();
      if (!isCaptchaPage(current)) {
        log('CAPTCHA résolu ✓', 'success');
        await sleep(1000);
        return;
      }
    } catch(e) { break; }
  }
  log('Timeout CAPTCHA — poursuite du script', 'warn');
}

async function waitUntilLoggedIn(page) {
  const isAuth = url =>
    url.includes('id.indeed.tech') || url.includes('/oauth') ||
    url.includes('/auth')          || url.includes('/login') ||
    url.includes('secure.indeed.com/account/login');

  if (!isAuth(page.url())) { log('Déjà connecté ✓', 'success'); return; }

  log('Page de connexion — saisis ton mot de passe dans le navigateur.', 'warn');
  log('Le script reprend automatiquement une fois connecté.', 'warn');
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const url = page.url();
      // CAPTCHA pendant le login ?
      if (isCaptchaPage(url)) { await waitForCaptchaIfNeeded(page); continue; }
      if (!isAuth(url)) { log('Connexion détectée ✓', 'success'); await sleep(1500); return; }
    } catch(e) { break; }
  }
  throw new Error('Timeout connexion Indeed (3 min)');
}

// ─── SWITCH VERS LE COMPTE LICENCES ──────────────────────────────────────────

async function dismissAllPopups(page) {
  // Fermer bandeau cookies
  try {
    const c = page.locator('button:has-text("Tout refuser"), button:has-text("Autoriser"), button:has-text("Accept all")').first();
    if (await c.isVisible({ timeout: 2000 })) { await c.click(); await sleep(600); log('Cookies fermé', 'step'); }
  } catch(e) {}
  // Fermer popup "OK" (Changez facilement de compte)
  try {
    const ok = page.locator('button:has-text("OK")').first();
    if (await ok.isVisible({ timeout: 3000 })) { await ok.click(); await sleep(600); log('Popup OK fermé', 'step'); }
  } catch(e) {}
}

async function switchToLicenseAccount(page) {
  // Vérifier si déjà sur le bon compte
  const alreadyOk = await page.evaluate((pat) => {
    return new RegExp(pat, 'i').test(document.querySelector('header, nav')?.textContent || '');
  }, LICENSE_ACCOUNT_PATTERN.source).catch(() => false);
  if (alreadyOk) { log('Déjà sur le compte licences ✓', 'success'); return; }

  log('Basculement vers le compte de licences...', 'step');

  // Attendre que la page se stabilise (les popups arrivent avec un délai)
  await sleep(3000);

  // 1. Fermer bandeau cookies s'il est là
  try {
    const c = page.locator('button:has-text("Tout refuser"), button:has-text("Autoriser tous les cookies")').first();
    if (await c.isVisible({ timeout: 2000 })) { await c.click(); log('Cookies fermé', 'step'); await sleep(600); }
  } catch(e) {}

  // 2. Attendre et fermer le popup "OK" — il apparaît avec un délai, on attend jusqu'à 8s
  try {
    const ok = page.locator('button:has-text("OK")').first();
    await ok.waitFor({ state: 'visible', timeout: 8000 });
    await ok.click();
    log('Popup OK fermé ✓', 'step');
    await sleep(1000);
  } catch(e) { log('Pas de popup OK détecté', 'info'); }

  // 3. Cliquer sur le bouton employeur dans le header
  //    "ACTUA BELFORT / belfort@actua.fr" — on cherche avec getByText sur le header
  let clicked = false;
  try {
    // Chercher le bouton/div qui affiche le nom de l'agence dans le header
    const headerEmployer = page.locator('header').getByText(/@actua\.fr/i).first();
    if (await headerEmployer.isVisible({ timeout: 3000 })) {
      await headerEmployer.click();
      clicked = 'getByText email';
    }
  } catch(e) {}

  if (!clicked) {
    // Fallback JS : chercher dans le header l'élément avec le moins d'enfants qui contient @
    await page.evaluate(() => {
      const header = document.querySelector('header');
      if (!header) return;
      const all = Array.from(header.querySelectorAll('button, a, [role="button"]'));
      const t = all.find(el => /@/.test(el.textContent) || /actua belfort/i.test(el.textContent));
      if (t) { t.click(); return; }
      // Dernier recours : avant-dernier bouton du header
      if (all.length >= 2) all[all.length - 2].click();
    });
    clicked = 'JS fallback';
  }

  log(`Header cliqué : ${clicked}`, 'step');

  log(`Header cliqué : ${clicked}`, clicked ? 'step' : 'warn');
  await sleep(2000); // Attendre que le modal s'anime

  await page.screenshot({ path: 'screenshots/switcher_open.png' });
  log('Screenshot modal → screenshots/switcher_open.png', 'info');

  // 3. Chercher "Ideuzo for Actua" dans le modal
  //    Le modal contient une liste d'entreprises — on cherche le texte exact
  const ideuzoLocator = page.getByText('Ideuzo for Actua', { exact: false }).first();
  const visible = await ideuzoLocator.isVisible({ timeout: 5000 }).catch(() => false);

  if (visible) {
    // Clic JS pour contourner l'overlay ifl-portal qui intercepte les pointer events
    await ideuzoLocator.evaluate(el => el.click());
    log('"Ideuzo for Actua" cliqué ✓', 'success');
    await sleep(2500);
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await dismissAllPopups(page);
  } else {
    // Dernier recours : screenshot + ENTRÉE manuelle
    await page.screenshot({ path: 'screenshots/ideuzo_not_found.png' });
    log('Ideuzo for Actua non trouvé — sélection manuelle requise', 'warn');
    await waitEnter('  ✋  Sélectionne "Ideuzo for Actua" dans le navigateur puis ENTRÉE...\n');
  }
}

// ─── CRÉER UNE ALERTE ────────────────────────────────────────────────────────

async function createOneAlert(page, alert, agencySlug, alertIdx) {
  log(`  "${alert.job}"`, 'step');
  if (DRY_RUN) return { status: 'dry_run', job: alert.job };

  try {
    await page.goto(RESUMES_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);
    await waitForCaptchaIfNeeded(page); // CAPTCHA éventuel après navigation

    const what = page.locator([
      'input[placeholder*="Intitulé"]', 'input[placeholder*="intitulé"]',
      'input[placeholder*="poste"]',    'input[placeholder*="compétences"]',
      'input[placeholder*="emploi"]',   'input[id*="what"]',
      'input[name*="what"]',            'input[placeholder*="keyword"]',
    ].join(', ')).first();

    await what.waitFor({ state: 'visible', timeout: 15000 });
    // Triple clic + Ctrl+A + Delete pour vider complètement (évite l'autocomplete Indeed)
    await what.click({ clickCount: 3 });
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await sleep(300);
    await what.fill(alert.query);
    await sleep(500);
    // Échapper l'autocomplete si ouvert
    await page.keyboard.press('Escape');
    await sleep(200);

    const where = page.locator([
      'input[placeholder*="Ville"]', 'input[placeholder*="ville"]',
      'input[placeholder*="département"]', 'input[id*="where"]', 'input[name*="where"]',
    ].join(', ')).first();

    if (await where.isVisible().catch(() => false)) {
      await where.click({ clickCount: 3 });
      await where.fill('');
      await where.type(alert.location, { delay: 15 });
      await sleep(800);
      const sugg = page.locator('[role="option"]:first-child, [role="listbox"] li:first-child').first();
      if (await sugg.isVisible().catch(() => false)) await sugg.click();
      else await page.keyboard.press('Escape');
      await sleep(300);
    }

    await page.locator('button:has-text("Rechercher"), button[type="submit"]').first().click();
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await sleep(3000); // attendre plus longtemps que la page se stabilise

    if (alertIdx === 0) await page.screenshot({ path: `screenshots/search_${agencySlug}.png` });

    const alertLink = page.locator([
      'a:has-text("Configurez une alerte")',
      'button:has-text("Configurez une alerte")',
      'a:has-text("Enregistrer la recherche")',
      'a:has-text("Set up an alert")',
    ].join(', ')).first();

    // Attendre jusqu'à 10s que le bouton apparaisse (était 6s)
    const visible = await alertLink.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    if (!visible) {
      await page.screenshot({ path: `screenshots/no_alert_${agencySlug}_${alertIdx}.png` });
      log(`  Bouton absent — ${page.url().slice(0, 80)}`, 'warn');
      return { status: 'no_alert_btn', job: alert.job };
    }

    await alertLink.click();
    await sleep(1500);

    const nameInput = page.locator([
      'input[name="alertName"]', 'input[placeholder*="nom"]',
      'input[placeholder*="Name"]', '[role="dialog"] input[type="text"]',
      '.modal input[type="text"]',
    ].join(', ')).first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.click({ clickCount: 3 });
      await nameInput.fill(alert.job);
      await sleep(300);
    }

    // Enregistrer — clic JS pour contourner l'overlay onetrust qui intercepte les events
    const saveBtn = page.locator('[data-cauto-id="serp_saved-search-modal_save-button"], button:has-text("Enregistrer"), button:has-text("Save")').first();
    await saveBtn.waitFor({ state: 'visible', timeout: 8000 });
    // Forcer le clic via JS (bypass l'overlay onetrust-consent-sdk)
    await saveBtn.evaluate(el => el.click());
    await sleep(2000);

    log(`  ✅ "${alert.job}"`, 'success');
    return { status: 'success', job: alert.job };

  } catch(err) {
    await page.screenshot({ path: `screenshots/err_${Date.now()}.png` }).catch(()=>{});
    log(`  ❌ ${err.message}`, 'error');
    return { status: 'error', job: alert.job, error: err.message };
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  🎯  ACTUA — Alertes CV Indeed  [v13]');
  console.log('══════════════════════════════════════════════════════════════\n');

  let agencies = ALERTS_DATA.slice(FROM);
  if (SINGLE_AGENCY) {
    agencies = ALERTS_DATA.filter(a => a.agency.toLowerCase().includes(SINGLE_AGENCY.toLowerCase()));
    if (!agencies.length) { log(`Introuvable : "${SINGLE_AGENCY}"`, 'error'); process.exit(1); }
  }
  if (LIMIT) {
    agencies = agencies.slice(0, LIMIT);
    log(`Limite : ${LIMIT} agence(s)`, 'info');
  }
  if (FROM > 0 && !SINGLE_AGENCY) log(`Départ depuis agence #${FROM + 1}`, 'info');
  log(`${agencies.length} agence(s) — ${agencies.reduce((s,a)=>s+a.alerts.length,0)} alertes`, 'info');

  const browser  = await chromium.launch({ headless: false, slowMo: 120, args: ['--start-maximized'] });
  const context  = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 900 } });
  const sfPage   = await context.newPage();

  // ── Ouverture Salesforce — détection auto ──
  await sfPage.goto(SALESFORCE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  log('Salesforce ouvert. Connecte-toi si besoin.', 'warn');
  log('Le script détecte automatiquement quand tu es prêt.', 'warn');
  await waitForSalesforceReady(sfPage);

  let indeedPage   = null;
  let passwordDone = false;
  const rapport    = { date: new Date().toISOString(), agencies: [] };

  for (let i = 0; i < agencies.length; i++) {
    const ag     = agencies[i];
    const agSlug = ag.agency.replace(/[^a-zA-Z0-9]/g, '_');
    console.log('\n──────────────────────────────────────────────────────────────');
    log(`[${i+1}/${agencies.length}] ${ag.agency} — ${ag.email}`, 'info');

    const agRep = { agency: ag.agency, email: ag.email, total: ag.alerts.length, success:0, skipped:0, errors:0, results:[] };

    try {
      await sfFillAndSearch(sfPage, ag.email);

      const newPage = await clickLoginAsAdvertiser(context, sfPage);

      if (!passwordDone) {
        await waitUntilLoggedIn(newPage);
        passwordDone = true;
      } else {
        await sleep(2000);
        await newPage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      }

      if (indeedPage && indeedPage !== sfPage && indeedPage !== newPage) {
        await indeedPage.close().catch(() => {});
      }
      indeedPage = newPage;

      await switchToLicenseAccount(indeedPage);

      for (let j = 0; j < ag.alerts.length; j++) {
        log(`[${j+1}/${ag.alerts.length}]`, 'info');
        const r = await createOneAlert(indeedPage, ag.alerts[j], agSlug, j);
        agRep.results.push(r);
        if (['success','dry_run'].includes(r.status)) agRep.success++;
        else if (r.status === 'no_alert_btn')         agRep.skipped++;
        else                                          agRep.errors++;
        await sleep(1500 + Math.random() * 1500); // délai aléatoire 1.5-3s
      }

      await sfPage.bringToFront();

    } catch(err) {
      log(`Erreur : ${err.message}`, 'error');
      agRep.global_error = err.message;
      await sfPage.screenshot({ path: `screenshots/${i+1}_ERREUR.png` }).catch(()=>{});
      await sfPage.bringToFront();
    }

    rapport.agencies.push(agRep);
    log(`→ ${agRep.success} OK | ${agRep.skipped} ignorées | ${agRep.errors} erreurs`,
        agRep.errors > 0 ? 'warn' : 'success');
    await sleep(1000);
  }

  await browser.close();
  fs.writeFileSync('rapport_execution.json', JSON.stringify(rapport, null, 2));
  log(`Terminé — ${rapport.agencies.reduce((s,a)=>s+(a.success||0),0)} alertes créées`, 'success');
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
