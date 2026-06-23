/**
 * Indeed Smart Sourcing — Alertes CV v14
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

// Anti-CAPTCHA : pause longue tous les BATCH_SIZE alertes (réglable via --batch et --pause)
const BATCH_SIZE    = (() => { const i = process.argv.indexOf('--batch'); return i !== -1 ? parseInt(process.argv[i+1]) : 25; })();
const PAUSE_MS      = (() => { const i = process.argv.indexOf('--pause'); return i !== -1 ? parseInt(process.argv[i+1]) * 1000 : 90000; })(); // défaut 90s
let   globalAlertCount = 0;

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

  // Cliquer le bouton "Search" dans le shadow DOM (en plus de Enter pour fiabilité)
  await sfPage.evaluate(() => {
    function deepFindAll(root, sel) {
      const r = [];
      root.querySelectorAll(sel).forEach(el => r.push(el));
      root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) r.push(...deepFindAll(el.shadowRoot, sel)); });
      return r;
    }
    const btns = deepFindAll(document, 'button, [role="button"], input[type="submit"]');
    const searchBtn = btns.find(b => /^\s*(search|rechercher)\s*$/i.test(b.textContent || b.value || ''));
    if (searchBtn) { searchBtn.removeAttribute('tabindex'); searchBtn.click(); }
  }).catch(() => {});

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
// Surveille si un CAPTCHA apparaît (URL OU contenu de page) et attend la résolution

const isCaptchaPage = url =>
  url.includes('captcha') ||
  url.includes('challenge') ||
  url.includes('recaptcha') ||
  url.includes('arkose') ||
  url.includes('funcaptcha') ||
  url.includes('datadome');

// Détecter un CAPTCHA dans le contenu de la page (même si l'URL ne change pas)
async function hasCaptchaInPage(page) {
  return await page.evaluate(() => {
    // 1. Éléments DOM spécifiques aux CAPTCHA (signaux forts et fiables)
    if (document.querySelector('#px-captcha, .px-captcha, [id^="datadome"], .h-captcha, #challenge-running, #challenge-stage')) {
      return true;
    }

    // 2. iframes de CAPTCHA actives ET visibles
    const iframes = Array.from(document.querySelectorAll('iframe'));
    const captchaFrame = iframes.find(f => {
      if (!/recaptcha\/api2\/bframe|arkose|funcaptcha|hcaptcha\.com\/captcha|datadome|geo\.captcha/i.test(f.src || '')) return false;
      const rect = f.getBoundingClientRect();
      return rect.width > 100 && rect.height > 100; // iframe réellement affichée
    });
    if (captchaFrame) return true;

    // 3. reCAPTCHA checkbox visible (pas juste le script chargé en arrière-plan)
    const grecaptcha = document.querySelector('.g-recaptcha');
    if (grecaptcha) {
      const rect = grecaptcha.getBoundingClientRect();
      if (rect.width > 50 && rect.height > 50) return true;
    }

    // 4. Texte de blocage — UNIQUEMENT si la page est quasi vide (vraie page de challenge,
    //    pas une page de résultats qui contiendrait ces mots dans un menu/footer)
    const txt = (document.body?.innerText || '').toLowerCase();
    const bodyLen = txt.length;
    if (bodyLen < 1500) {
      const strongSignals = [
        'press and hold',
        'appuyez et maintenez',
        'verify you are human',
        "verify you're human",
        'vérifiez que vous êtes un humain',
        'unusual traffic from your',
        'trafic inhabituel',
      ];
      if (strongSignals.some(s => txt.includes(s))) return true;
    }

    return false;
  }).catch(() => false);
}

async function waitForCaptchaIfNeeded(page) {
  const url = page.url();
  const inPage = await hasCaptchaInPage(page);
  if (!isCaptchaPage(url) && !inPage) return;

  log('⚠️  CAPTCHA détecté ! Résous-le dans le navigateur.', 'warn');
  log('Le script reprend automatiquement une fois le CAPTCHA résolu.', 'warn');
  // Bip sonore pour alerter
  process.stdout.write('\x07');

  const deadline = Date.now() + 600_000; // 10 min max
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const current = page.url();
      const stillCaptcha = isCaptchaPage(current) || await hasCaptchaInPage(page);
      if (!stillCaptcha) {
        log('CAPTCHA résolu ✓', 'success');
        await sleep(1500);
        return;
      }
    } catch(e) { break; }
  }
  log('Timeout CAPTCHA (10 min) — poursuite du script', 'warn');
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

async function createOneAlert(page, alert, agencySlug, alertIdx, country = 'FR', lang = 'fr') {
  log(`  "${alert.job}"`, 'step');
  if (DRY_RUN) return { status: 'dry_run', job: alert.job };

  try {
    // Navigation directe vers la page de résultats via URL — plus fiable que remplir les champs
    // Format : resumes.indeed.com/search?q=REQUETE&l=VILLE&co=PAYS&hl=LANGUE
    const q = encodeURIComponent(alert.query);
    const l = encodeURIComponent(alert.location || '');
    const searchUrl = `https://resumes.indeed.com/search?q=${q}&l=${l}&co=${country}&hl=${lang}&radius=${alert.radius || 25}`;

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(2500);
    await waitForCaptchaIfNeeded(page); // CAPTCHA éventuel après navigation
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await sleep(2000);

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
      'a:has-text("Zoekopdracht opslaan")',
      'button:has-text("Zoekopdracht opslaan")',
      'a:has-text("Melding instellen")',
      'button:has-text("Melding instellen")',
      // NL — libellé réel sur Indeed Smart Sourcing : « Stel een cv-alert in »
      'a:has-text("Stel een cv-alert in")',
      'button:has-text("Stel een cv-alert in")',
      'a:has-text("cv-alert in")',
      'button:has-text("cv-alert in")',
      'a:has-text("cv-alert instellen")',
      'button:has-text("cv-alert instellen")',
    ].join(', ')).first();

    // Attendre jusqu'à 10s que le bouton apparaisse (était 6s)
    let visible = await alertLink.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);

    // Si bouton absent, re-vérifier si c'est un CAPTCHA qui bloque (et non 0 résultats)
    if (!visible) {
      const captcha = await hasCaptchaInPage(page);
      if (captcha) {
        await waitForCaptchaIfNeeded(page);
        // Recharger la recherche après résolution et réessayer
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await sleep(2500);
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        visible = await alertLink.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
      }
    }

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
      .or(page.locator('button:has-text("Enregistrer"), button:has-text("Save"), button:has-text("Opslaan"), button:has-text("Instellen"), button:has-text("Cv-alert instellen")').first());

    // L'enregistrement peut ne pas passer par une modal : sur certains comptes NL
    // (« Stel een cv-alert in »), l'alerte est créée directement au clic. Si aucun
    // bouton d'enregistrement n'apparaît, on considère l'alerte créée.
    const hasSaveBtn = await saveBtn.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
    if (!hasSaveBtn) {
      await sleep(1000);
      log(`  ✅ "${alert.job}" (création directe)`, 'success');
      return { status: 'success', job: alert.job };
    }

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
  console.log('  🎯  Indeed — Alertes CV Smart Sourcing  [v14]');
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
  log(`Anti-CAPTCHA : pause de ${Math.round(PAUSE_MS/1000)}s toutes les ${BATCH_SIZE} alertes`, 'info');

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
        const r = await createOneAlert(indeedPage, ag.alerts[j], agSlug, j, ag.country || 'FR', ag.lang || 'fr');
        agRep.results.push(r);
        if (['success','dry_run'].includes(r.status)) agRep.success++;
        else if (r.status === 'no_alert_btn')         agRep.skipped++;
        else                                          agRep.errors++;

        // Compteur global d'alertes traitées
        globalAlertCount++;

        // Pause longue anti-CAPTCHA tous les BATCH_SIZE alertes
        if (globalAlertCount % BATCH_SIZE === 0) {
          const pauseSec = Math.round(PAUSE_MS / 1000);
          log(`⏸️  Pause anti-CAPTCHA de ${pauseSec}s (${globalAlertCount} alertes traitées)...`, 'step');
          await sleep(PAUSE_MS);
          log('▶️  Reprise', 'step');
        }

        await sleep(2000 + Math.random() * 2000); // délai aléatoire 2-4s
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
