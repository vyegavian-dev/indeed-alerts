/**
 * Indeed Smart Sourcing — Alertes CV v13
 * npm init -y && npm install playwright && npx playwright install chromium
 * node setup_indeed_alerts.js --agency "email@domaine.com"
 */

const { chromium } = require('playwright');
const fs       = require('fs');
const readline = require('readline');

const RAW_DATA      = JSON.parse(fs.readFileSync('alerts_data.json', 'utf8'));
// Support both formats: array of recruiters OR {licenseAccount, recruiters:[...]}
const ALERTS_DATA   = Array.isArray(RAW_DATA) ? RAW_DATA : (RAW_DATA.recruiters || RAW_DATA);
const LICENSE_ACCOUNT_STR     = Array.isArray(RAW_DATA) ? 'license account' : (RAW_DATA.licenseAccount || 'license account');
// Nettoyer les emojis et caractères spéciaux pour le regex
const LICENSE_ACCOUNT_CLEAN   = LICENSE_ACCOUNT_STR.replace(/[^\w\s\-]/g, '').trim();
const LICENSE_ACCOUNT_PATTERN = new RegExp(LICENSE_ACCOUNT_CLEAN, 'i');
const DRY_RUN       = process.argv.includes('--dry-run');
const SINGLE_AGENCY = (() => { const i = process.argv.indexOf('--agency'); return i !== -1 ? process.argv[i+1] : null; })();
const LIMIT         = (() => { const i = process.argv.indexOf('--limit');  return i !== -1 ? parseInt(process.argv[i+1]) : null; })();
const FROM          = (() => { const i = process.argv.indexOf('--from');   return i !== -1 ? parseInt(process.argv[i+1]) - 1 : 0; })(); // 1-based

const SALESFORCE_URL          = 'https://indeedinc.lightning.force.com/lightning/n/IndeedAccountSearch';
const RESUMES_URL             = 'https://resumes.indeed.com/?co=FR&hl=fr&prevCo=FR';
// LICENSE_ACCOUNT_PATTERN est lu dynamiquement depuis alerts_data.json (champ licenseAccount)

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
  log('Salesforce ouvert — connecte-toi si besoin.', 'warn');
  log('Le script reprend automatiquement une fois connecté.', 'warn');

  const deadline = Date.now() + 180_000; // 3 min max
  while (Date.now() < deadline) {
    try {
      const url = sfPage.url();
      if (url.includes('lightning.force.com') || url.includes('IndeedAccountSearch')) {
        // Attendre que le composant Lightning soit rendu (input visible)
        const inputReady = await sfPage.evaluate(() => {
          function deepFindAll(root) {
            const r = [];
            root.querySelectorAll('input').forEach(el => r.push(el));
            root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) r.push(...deepFindAll(el.shadowRoot)); });
            return r;
          }
          return !!deepFindAll(document).find(i => /email/i.test(i.placeholder) || /resume/i.test(i.placeholder));
        }).catch(() => false);

        if (inputReady) {
          log('Salesforce prêt ✓', 'success');
          return;
        }
      }
    } catch(e) {}
    await sleep(1000);
  }
  throw new Error('Timeout Salesforce (3 min)');
}

async function sfFillAndSearch(sfPage, email) {
  log(`Salesforce → ${email}`, 'step');
  await sfPage.goto(SALESFORCE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Attendre que le composant Lightning charge l'input (shadow DOM) — max 15s
  log('Attente du chargement de la page...', 'step');
  let inputFound = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    inputFound = await sfPage.evaluate(() => {
      function deepFindAll(root) {
        const r = [];
        root.querySelectorAll('input').forEach(el => r.push(el));
        root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) r.push(...deepFindAll(el.shadowRoot)); });
        return r;
      }
      const all = deepFindAll(document);
      return !!all.find(i => /email/i.test(i.placeholder) || /resume/i.test(i.placeholder));
    }).catch(() => false);
    if (inputFound) { log('Page prête ✓', 'success'); break; }
    await sleep(800);
  }
  if (!inputFound) throw new Error('Input Salesforce introuvable après 15s');

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

  const tryClick = () => sfPage.evaluate(() => {
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
  });

  // Tentative 1
  let [newPage, btnFound] = await Promise.all([
    context.waitForEvent('page', { timeout: 20000 }).catch(() => null),
    tryClick(),
  ]);

  // Si le bouton n'existe pas du tout → compte sans accès advertiser
  if (!btnFound) {
    throw new Error('Bouton "Login As Advertiser" introuvable — compte sans accès advertiser dans Salesforce');
  }

  // Retry si aucun onglet ne s'est ouvert (clic parfois sans effet)
  if (!newPage) {
    log('Pas de nouvel onglet — nouvelle tentative...', 'step');
    await sleep(2000);
    [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 15000 }).catch(() => null),
      tryClick(),
    ]);
  }

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
  // ── Vérifier si on est déjà sur le bon compte ──────────────────────────────
  // Cas Hoerdt et similaires : "Login As Advertiser" atterrit directement sur Ideuzo
  const checkAlready = async () => page.evaluate((pat) => {
    return new RegExp(pat, 'i').test(document.querySelector('header, nav')?.textContent || '');
  }, LICENSE_ACCOUNT_PATTERN.source).catch(() => false);

  // Attendre que la page se stabilise (max 5s) puis vérifier
  await sleep(2000);
  if (await checkAlready()) {
    log('Déjà sur le compte licences ✓ (pas de switch nécessaire)', 'success');
    return;
  }

  log('Basculement vers le compte de licences...', 'step');

  // ── 1. Fermer les popups bloquants ─────────────────────────────────────────
  // Cookies
  try {
    const c = page.locator('button:has-text("Tout refuser"), button:has-text("Autoriser tous les cookies")').first();
    if (await c.isVisible({ timeout: 2000 })) { await c.click(); log('Cookies fermé', 'step'); await sleep(500); }
  } catch(e) {}

  // Popup "Changez facilement de compte" → bouton OK
  // On attend jusqu'à 6s (il arrive avec un délai)
  try {
    const ok = page.locator('button:has-text("OK")').first();
    await ok.waitFor({ state: 'visible', timeout: 6000 });
    await ok.click();
    log('Popup OK fermé ✓', 'step');
    await sleep(800);
    // Re-vérifier : parfois le popup OK apparaît justement parce qu'on est déjà sur Ideuzo
    if (await checkAlready()) {
      log('Déjà sur le compte licences après popup ✓', 'success');
      return;
    }
  } catch(e) { log('Pas de popup OK', 'info'); }

  // ── 2. Ouvrir le modal switcher ─────────────────────────────────────────────
  try {
    const headerEmployer = page.locator('header').getByText(/@/).first();
    if (await headerEmployer.isVisible({ timeout: 3000 })) {
      await headerEmployer.click();
      log('Switcher ouvert (email header)', 'step');
    }
  } catch(e) {
    await page.evaluate(() => {
      const header = document.querySelector('header');
      if (!header) return;
      const all = Array.from(header.querySelectorAll('button, a, [role="button"]'));
      const t = all.find(el => /@/.test(el.textContent))
             || all[all.length - 2];
      if (t) t.click();
    });
    log('Switcher ouvert (JS fallback)', 'step');
  }
  await sleep(2000);

  // ── 3. Cliquer le compte licences dans le modal ────────────────────────────
  const ideuzoLocator = page.getByText(LICENSE_ACCOUNT_STR, { exact: false }).first();
  const visible = await ideuzoLocator.isVisible({ timeout: 5000 }).catch(() => false);

  if (visible) {
    await ideuzoLocator.evaluate(el => el.click());
    log(`"${LICENSE_ACCOUNT_STR}" cliqué ✓`, 'success');
    await sleep(2500);
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    try {
      const ok2 = page.locator('button:has-text("OK")').first();
      if (await ok2.isVisible({ timeout: 2000 })) { await ok2.click(); await sleep(500); }
    } catch(e) {}
  } else {
    await page.screenshot({ path: `screenshots/ideuzo_not_found.png`, timeout: 5000 }).catch(() => {});
    log(`"${LICENSE_ACCOUNT_STR}" non trouvé — recruteur ignoré (compte non éligible)`, 'warn');
    throw new Error(`Compte licences "${LICENSE_ACCOUNT_STR}" non trouvé — recruteur ignoré`);
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

    if (alertIdx === 0) await page.screenshot({ path: `screenshots/search_${agencySlug}.png`, timeout: 5000 }).catch(() => {});

    const alertLink = page.locator([
      'a:has-text("Configurez une alerte")',
      'button:has-text("Configurez une alerte")',
      'a:has-text("Enregistrer la recherche")',
      'button:has-text("Enregistrer la recherche")',
      'a:has-text("Créer une alerte")',
      'button:has-text("Créer une alerte")',
      'a:has-text("Set up an alert")',
      'button:has-text("Set up an alert")',
      'a:has-text("Save search")',
      'button:has-text("Save search")',
      'a:has-text("Create alert")',
      'button:has-text("Create alert")',
    ].join(', ')).first();

    // Attendre jusqu'à 10s que le bouton apparaisse (était 6s)
    const visible = await alertLink.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    if (!visible) {
      await page.screenshot({ path: `screenshots/no_alert_${agencySlug}_${alertIdx}.png`, timeout: 5000 }).catch(() => {});
      log(`  Bouton absent — ${page.url().slice(0, 80)}`, 'warn');
      return { status: 'no_alert_btn', job: alert.job };
    }

    await alertLink.click();
    await sleep(1500);

    // ── Fermer le bandeau cookies s'il recouvre la modal ──────────────────────
    try {
      const cookie = page.locator('#onetrust-accept-btn-handler, button:has-text("Tout refuser"), button:has-text("Autoriser tous les cookies")').first();
      if (await cookie.isVisible({ timeout: 1500 })) {
        await cookie.evaluate(el => el.click());
        log('  Cookie banner fermé avant modal', 'step');
        await sleep(500);
      }
    } catch(e) {}

    // ── Remplir le nom de l'alerte ────────────────────────────────────────────
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

    // ── Cliquer Enregistrer ───────────────────────────────────────────────────
    // On cible par data-cauto-id (sélecteur stable) en priorité
    const saveBtn = page.locator('[data-cauto-id="serp_saved-search-modal_save-button"]')
      .or(page.locator('button:has-text("Enregistrer"), button:has-text("Save")').first());
    await saveBtn.waitFor({ state: 'visible', timeout: 8000 });

    // 1ère tentative : clic JS (bypass onetrust overlay)
    await saveBtn.evaluate(el => el.click());
    await sleep(1000);

    // Vérifier que la modal s'est fermée
    const modalGone = await saveBtn.isHidden({ timeout: 3000 }).catch(() => false);
    if (!modalGone) {
      // 2ème tentative : force click Playwright
      log('  Retry Enregistrer (force click)...', 'step');
      await saveBtn.click({ force: true });
      await sleep(1000);
      // 3ème tentative : scroll + click
      const stillThere = await saveBtn.isVisible().catch(() => false);
      if (stillThere) {
        await saveBtn.scrollIntoViewIfNeeded();
        await saveBtn.evaluate(el => el.click());
        await sleep(1000);
      }
    }

    // Confirmer le succès : la modal doit être fermée
    const confirmed = await saveBtn.isHidden({ timeout: 3000 }).catch(() => false);
    if (!confirmed) {
      await page.screenshot({ path: `screenshots/save_failed_${agencySlug}_${alertIdx}.png`, timeout: 5000 }).catch(() => {});
      log(`  ⚠️  Modal toujours ouverte après 3 tentatives`, 'warn');
      return { status: 'save_failed', job: alert.job };
    }

    await sleep(1000);

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
  console.log('  🎯  Indeed — Alertes CV Smart Sourcing  [v13]');
  console.log('══════════════════════════════════════════════════════════════\n');

  let agencies = ALERTS_DATA.slice(FROM);
  if (SINGLE_AGENCY) {
    agencies = ALERTS_DATA.filter(a => a.agency.toLowerCase().includes(SINGLE_AGENCY.toLowerCase()));
    if (!agencies.length) { log(`Introuvable : "${SINGLE_AGENCY}"`, 'error'); process.exit(1); }
  }
  if (LIMIT) {
    agencies = agencies.slice(0, LIMIT);
    log(`Limite : ${LIMIT} recruteur(s)`, 'info');
  }
  if (FROM > 0 && !SINGLE_AGENCY) log(`Départ depuis recruteur #${FROM + 1}`, 'info');
  log(`${agencies.length} recruteur(s) — ${agencies.reduce((s,a)=>s+a.alerts.length,0)} alertes`, 'info');
  log(`Compte licences : "${LICENSE_ACCOUNT_STR}"`, 'info');

  const browser  = await chromium.launch({
    headless: false,
    slowMo: 120,
    args: [
      '--start-maximized',
      '--disable-features=FocusOnTabCreate',  // empêche le focus sur nouvelle tab
      '--no-first-run',
      '--disable-background-timer-throttling',
    ]
  });
  const context  = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 900 } });
  const sfPage   = await context.newPage();

  // ── Ouverture Salesforce ──
  await sfPage.goto(SALESFORCE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForSalesforceReady(sfPage);

  let indeedPage   = null;
  let passwordDone = false;
  const rapport    = { date: new Date().toISOString(), agencies: [] };

  for (let i = 0; i < agencies.length; i++) {
    const ag     = agencies[i];
    const agSlug = ( ag.agency || ag.email || ag.email || 'agency' ).replace(/[^a-zA-Z0-9]/g, '_');
    console.log('\n──────────────────────────────────────────────────────────────');
    log(`[${i+1}/${agencies.length}] ${ag.agency || ag.email} — ${ag.email}`, 'info');

    const agRep = { agency: ag.agency || ag.email, email: ag.email, total: ag.alerts.length, success:0, skipped:0, errors:0, results:[] };

    try {
      // Fermer l'onglet du recruteur précédent AVANT de cliquer Login As Advertiser
      // pour forcer l'ouverture d'un nouvel onglet propre
      if (indeedPage && indeedPage !== sfPage) {
        await indeedPage.close().catch(() => {});
        indeedPage = null;
      }

      await sfFillAndSearch(sfPage, ag.email);

      const newPage = await clickLoginAsAdvertiser(context, sfPage);

      // Fix 1: si aucun onglet Indeed n'a été ouvert, le script a récupéré sfPage en fallback → erreur
      if (newPage === sfPage) {
        throw new Error('Login As Advertiser n\'a pas ouvert de nouvel onglet — recruteur ignoré');
      }

      // Vérifier que la page est réellement utilisable
      const pageUrl = newPage.url();
      if (!pageUrl || pageUrl === 'about:blank') {
        await sleep(3000);
        const urlAfterWait = newPage.url();
        if (!urlAfterWait || urlAfterWait === 'about:blank') {
          throw new Error('Onglet ouvert vide — Login As Advertiser a échoué pour ce recruteur');
        }
      }

      // Fix 2: toujours vérifier si une page de login est affichée, peu importe passwordDone
      // (certains comptes déclenchent un re-login même après la 1ère connexion)
      await waitUntilLoggedIn(newPage);
      passwordDone = true;

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


    } catch(err) {
      log(`Erreur : ${err.message}`, 'error');
      agRep.global_error = err.message;
      await sfPage.screenshot({ path: `screenshots/${i+1}_ERREUR.png` }).catch(()=>{});
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
