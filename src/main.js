import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import { router } from './routes.js';
import { PROVINCIAS } from './provincias.js';
import { getLastPing } from './heartbeat.js';

await Actor.init();

const input = await Actor.getInput() ?? {};

const {
    keyword = 'INSTALACIONES',
    maxPagesPerProvince = 40,
    provincias = PROVINCIAS.map(p => p.code),
    maxConcurrency = 2,
    delayBetweenRequests = 3000,
    captchaApiKey = '',
    captchaMaxRetries = 2,
    enableCityFallback = false,
    minCityResults = 20,
    requireWeb = false,
    requirePhone = false,
    requireEmail = false,
    minEmployees = null,
    maxEmployees = null,
    maxIdleSecs = 600,
    proxyConfig = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
} = input;

const parsedMinEmployees = Number.isFinite(minEmployees) ? Math.max(0, Math.trunc(minEmployees)) : null;
const parsedMaxEmployees = Number.isFinite(maxEmployees) ? Math.max(0, Math.trunc(maxEmployees)) : null;

let effectiveMinEmployees = parsedMinEmployees;
let effectiveMaxEmployees = parsedMaxEmployees;

if (effectiveMinEmployees !== null && effectiveMaxEmployees !== null && effectiveMinEmployees > effectiveMaxEmployees) {
    log.warning(`minEmployees (${effectiveMinEmployees}) is greater than maxEmployees (${effectiveMaxEmployees}), swapping values.`);
    [effectiveMinEmployees, effectiveMaxEmployees] = [effectiveMaxEmployees, effectiveMinEmployees];
}

if (captchaApiKey) {
    log.info('2Captcha API key configured — reCAPTCHA solving enabled');
} else {
    log.warning('No 2Captcha API key — if reCAPTCHA appears, pages will be retried with new proxy but NOT solved');
}

const hasEmployeeFilter = effectiveMinEmployees !== null || effectiveMaxEmployees !== null;
const filtersActive = requireWeb || requirePhone || requireEmail || hasEmployeeFilter;
if (filtersActive) {
    const filters = [requireWeb && 'Web', requirePhone && 'Teléfono', requireEmail && 'Email'].filter(Boolean);
    if (hasEmployeeFilter) {
        const minLabel = effectiveMinEmployees !== null ? `${effectiveMinEmployees}` : '0';
        const maxLabel = effectiveMaxEmployees !== null ? `${effectiveMaxEmployees}` : '∞';
        filters.push(`Empleados ${minLabel}-${maxLabel}`);
    }
    log.info(`Native empresite filters active: ${filters.join(', ')}`);
    log.info('In-session pagination mode: each province will paginate via clicks (not URL navigation) to preserve filter state');
    log.info(`Concurrency capped at 1 for filter mode to avoid conflicts`);
}

// Store config in key-value store for routes to access
const kvStore = await Actor.openKeyValueStore();
await kvStore.setValue('CONFIG', {
    keyword,
    maxPagesPerProvince,
    captchaApiKey,
    captchaMaxRetries,
    enableCityFallback,
    minCityResults,
    requireWeb,
    requirePhone,
    requireEmail,
    minEmployees: effectiveMinEmployees,
    maxEmployees: effectiveMaxEmployees,
});

// Setup proxy
const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);

// In filter mode, each LISTING request handles ALL pages in-session (up to 40),
// so we need a much longer timeout. Also cap concurrency to 1 to avoid conflicts
// with the KV-store progress tracking.
const effectiveConcurrency = filtersActive ? 1 : maxConcurrency;
const effectiveHandlerTimeout = filtersActive
    ? Math.max(300, maxPagesPerProvince * 15)  // ~15s per page × pages
    : 120;

// Rotate user-agents to reduce fingerprinting
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
];

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: effectiveConcurrency,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: effectiveHandlerTimeout,
    maxRequestRetries: 5,

    // Anti-detection
    launchContext: {
        launchOptions: {
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
            ],
        },
    },

    // Delay between requests + random user-agent
    preNavigationHooks: [
        async (crawlingContext) => {
            if (delayBetweenRequests > 0) {
                // Add ±30% jitter to seem more human
                const jitter = delayBetweenRequests * (0.7 + Math.random() * 0.6);
                await new Promise(r => setTimeout(r, jitter));
            }
            // Rotate user-agent per request
            const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
            await crawlingContext.page?.setExtraHTTPHeaders({ 'User-Agent': ua }).catch(() => {});
        },
    ],

    // Handle cookies banner automatically
    postNavigationHooks: [
        async (crawlingContext) => {
            const { page } = crawlingContext;
            try {
                const cookieBtn = page.locator('button:has-text("Agree"), button:has-text("Disagree and close"), #didomi-notice-agree-button, button:has-text("Aceptar")');
                await cookieBtn.first().click({ timeout: 3000 }).catch(() => {});
            } catch {
                // Cookie banner not present, continue
            }
        },
    ],

    requestHandler: router,

    failedRequestHandler({ request }, error) {
        log.warning(`Request ${request.url} failed: ${error.message}`);
    },
});

// Build starting URLs: one per province
const keywordUrl = keyword.toUpperCase().replace(/\s+/g, '-');
const startUrls = provincias.map(provinciaCode => ({
    url: `https://empresite.eleconomista.es/Actividad/${keywordUrl}/provincia/${provinciaCode}/`,
    label: 'LISTING',
    userData: {
        keyword: keywordUrl,
        provincia: provinciaCode,
        page: 1,
    },
}));

log.info(`Starting scrape for "${keyword}" across ${startUrls.length} provinces`);
log.info(`Idle watchdog: will exit gracefully if no activity for ${maxIdleSecs}s (set maxIdleSecs=0 to disable)`);

// ── Watchdog: exit gracefully if stuck / no results for maxIdleSecs ──────────
let watchdog = null;
if (maxIdleSecs > 0) {
    watchdog = setInterval(async () => {
        const idleMs = Date.now() - getLastPing();
        if (idleMs > maxIdleSecs * 1000) {
            const idleSecs = Math.round(idleMs / 1000);
            log.warning(`No scraper activity for ${idleSecs}s (maxIdleSecs=${maxIdleSecs}) — finishing gracefully`);
            clearInterval(watchdog);
            // Exit with success — data already saved to dataset
            await Actor.exit({ exitCode: 0 });
        }
    }, 30_000); // check every 30 seconds
}

await crawler.run(startUrls);

if (watchdog) clearInterval(watchdog);

// Log summary
const dataset = await Actor.openDataset();
const info = await dataset.getInfo();
const totalItems = info?.itemCount ?? 0;

log.info('═══════════════════════════════════════════════════════════════');
log.info(`  Scrape complete!`);
log.info(`  Keyword:     ${keyword}`);
log.info(`  Provinces:   ${startUrls.length}`);
log.info(`  Total items: ${totalItems}`);
if (filtersActive) {
    const filters = [requireWeb && 'Web', requirePhone && 'Teléfono', requireEmail && 'Email'].filter(Boolean);
    if (hasEmployeeFilter) {
        const minLabel = effectiveMinEmployees !== null ? `${effectiveMinEmployees}` : '0';
        const maxLabel = effectiveMaxEmployees !== null ? `${effectiveMaxEmployees}` : '∞';
        filters.push(`Empleados ${minLabel}-${maxLabel}`);
    }
    log.info(`  Filters:     ${filters.join(', ')}`);
}
log.info('═══════════════════════════════════════════════════════════════');

await Actor.exit();
