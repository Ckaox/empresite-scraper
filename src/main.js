import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import { router } from './routes.js';
import { PROVINCIAS } from './provincias.js';

await Actor.init();

const input = await Actor.getInput() ?? {};

const {
    keyword = 'INSTALACIONES',
    maxPagesPerProvince = 40,
    provincias = PROVINCIAS.map(p => p.code),
    maxConcurrency = 5,
    delayBetweenRequests = 2000,
    captchaApiKey = '',
    captchaMaxRetries = 2,
    scrapeDetails = false,
    enableCityFallback = false,
    requireWeb = false,
    requirePhone = false,
    requireEmail = false,
    proxyConfig = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
} = input;

if (captchaApiKey) {
    log.info('2Captcha API key configured — reCAPTCHA solving enabled');
} else {
    log.warning('No 2Captcha API key — if reCAPTCHA appears, pages will be retried with new proxy but NOT solved');
}

if (scrapeDetails) {
    log.info('scrapeDetails=true: will visit each company profile page to extract phone/email/website');
    if (requireWeb || requirePhone || requireEmail) {
        const filters = [requireWeb && 'web', requirePhone && 'phone', requireEmail && 'email'].filter(Boolean);
        log.info(`Active filters: ${filters.join(', ')}`);
    }
} else if (requireWeb || requirePhone || requireEmail) {
    log.warning('requireWeb/Phone/Email filters are only applied when scrapeDetails=true');
}

// Store config in key-value store for routes to access
const kvStore = await Actor.openKeyValueStore();
await kvStore.setValue('CONFIG', {
    keyword,
    maxPagesPerProvince,
    captchaApiKey,
    captchaMaxRetries,
    scrapeDetails,
    enableCityFallback,
    requireWeb,
    requirePhone,
    requireEmail,
});

// Setup proxy
const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
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

    // Delay between requests to avoid rate limiting
    preNavigationHooks: [
        async (crawlingContext) => {
            if (delayBetweenRequests > 0) {
                await new Promise(r => setTimeout(r, delayBetweenRequests));
            }
        },
    ],

    // Handle cookies banner automatically
    postNavigationHooks: [
        async (crawlingContext) => {
            const { page } = crawlingContext;
            try {
                // Try to dismiss cookie banner
                const cookieBtn = page.locator('button:has-text("Agree"), button:has-text("Disagree and close"), #didomi-notice-agree-button');
                await cookieBtn.first().click({ timeout: 3000 }).catch(() => {});
            } catch {
                // Cookie banner not present, continue
            }
        },
    ],

    requestHandler: router,

    // On failure, log but continue
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

await crawler.run(startUrls);

// Log summary
const dataset = await Actor.openDataset();
const info = await dataset.getInfo();
log.info(`Scrape complete. Total results: ${info?.itemCount ?? 0}`);

await Actor.exit();
