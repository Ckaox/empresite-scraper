import { createPlaywrightRouter, Dataset, log } from 'crawlee';
import { Actor } from 'apify';
import { detectRecaptcha, handleRecaptchaIfPresent } from './captchaSolver.js';

export const router = createPlaywrightRouter();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getConfig() {
    const kvs = await Actor.openKeyValueStore();
    return await kvs.getValue('CONFIG') ?? {};
}

async function handleCaptcha(page, request, config) {
    const captchaResult = await detectRecaptcha(page);
    if (!captchaResult.found) return;

    const { captchaApiKey = '', captchaMaxRetries = 2 } = config;
    const retryCount = request.userData.captchaRetries || 0;
    const { provincia, page: pageNum } = request.userData;

    log.warning(`reCAPTCHA detected on ${provincia} page ${pageNum}!`);

    if (captchaApiKey) {
        const { solved } = await handleRecaptchaIfPresent(page, captchaApiKey);
        if (solved) {
            await page.waitForSelector('h3 a', { timeout: 20000 }).catch(() => {});
            const recheck = await detectRecaptcha(page);
            if (recheck.found) {
                if (retryCount < captchaMaxRetries) {
                    request.userData.captchaRetries = retryCount + 1;
                    throw new Error('CAPTCHA_STILL_PRESENT');
                }
                log.error(`Giving up on ${provincia} page ${pageNum} after ${captchaMaxRetries} CAPTCHA retries`);
            }
        } else {
            if (retryCount < captchaMaxRetries) {
                request.userData.captchaRetries = retryCount + 1;
                throw new Error('CAPTCHA_SOLVE_FAILED');
            }
            log.error(`Giving up on ${provincia} page ${pageNum} — cannot solve CAPTCHA`);
        }
    } else {
        if (retryCount < captchaMaxRetries) {
            request.userData.captchaRetries = retryCount + 1;
            throw new Error('CAPTCHA_NO_SOLVER');
        }
        log.error(`reCAPTCHA on ${provincia} page ${pageNum} — no solver & max retries reached`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTING handler — search results page
// ─────────────────────────────────────────────────────────────────────────────

router.addHandler('LISTING', async ({ request, page, addRequests }) => {
    const { keyword, provincia, page: pageNum, cityMode = false, cityName = null } = request.userData;
    const locationLabel = cityMode ? `${provincia}/${cityName}` : provincia;

    log.info(`Processing: ${locationLabel} page ${pageNum}`);

    await page.waitForSelector('h3 a, .g-recaptcha, [data-sitekey]', { timeout: 20000 }).catch(() => {});

    const config = await getConfig();
    await handleCaptcha(page, request, config);

    const hasResults = await page.locator('h3 a').count();
    if (hasResults === 0) {
        log.info(`No results on ${locationLabel} page ${pageNum}, skipping`);
        return;
    }

    // Extract total results count
    const totalText = await page.locator('h2').first().textContent().catch(() => '');
    const totalMatch = totalText?.match(/[\d.]+/);
    const totalResults = totalMatch ? parseInt(totalMatch[0].replace(/\./g, ''), 10) : 0;

    // ── Extract company cards ──────────────────────────────────────────────────
    const companies = await page.evaluate(() => {
        const results = [];
        const h3Links = document.querySelectorAll('h3 a[href*=".html"]');

        h3Links.forEach(link => {
            const name = link.textContent?.trim() || '';
            const profileUrl = link.href || '';
            if (!name || !profileUrl) return;

            // Walk up to find card container
            let card = link.parentElement;
            for (let i = 0; i < 6; i++) {
                if (!card) break;
                if (card.querySelectorAll('h3 a[href*=".html"]').length === 1) break;
                card = card.parentElement;
            }

            const description = card?.querySelector('p')?.textContent?.trim() || '';

            let address = '';
            const allText = card?.textContent || '';
            const streetMatch = allText.match(
                /(?:Calle|Avenida|Plaza|Paseo|Camino|Carretera|Poligon|Urbanizaci|Lugar|Ronda|Travesia|Barrio|Parque)[^\[]*?(\d{5}[^\[]*)/i
            );
            if (streetMatch) {
                address = streetMatch[0]
                    .replace(/Coincidencia encontrada.*/i, '')
                    .replace(/VER EN MAPA.*/i, '')
                    .replace(/VER FICHA.*/i, '')
                    .trim();
            }

            results.push({ name, profileUrl, description, address });
        });

        return results;
    });

    const { scrapeDetails = false, keyword: cfgKeyword, requireWeb = false, requirePhone = false, requireEmail = false } = config;
    const anyFilterActive = requireWeb || requirePhone || requireEmail;

    if (scrapeDetails) {
        // Enqueue individual company profile pages for detail scraping
        if (companies.length > 0) {
            await addRequests(companies.map(c => ({
                url: c.profileUrl,
                label: 'DETAIL',
                userData: {
                    keyword: cfgKeyword || keyword,
                    provincia,
                    page: pageNum,
                    cityMode,
                    cityName,
                    name: c.name,
                    description: c.description,
                    address: c.address,
                    profileUrl: c.profileUrl,
                },
            })));
            log.info(`Enqueued ${companies.length} detail pages from ${locationLabel} page ${pageNum}`);
        }
    } else {
        if (anyFilterActive) {
            log.warning('requireWeb/Phone/Email only work with scrapeDetails:true — saving all results without filtering');
        }
        for (const company of companies) {
            await Dataset.pushData({
                keyword: cfgKeyword || keyword,
                provincia,
                city: cityName || null,
                page: pageNum,
                name: company.name,
                description: company.description,
                address: company.address,
                profileUrl: company.profileUrl,
                website: null,
                phone: null,
                email: null,
                scrapedAt: new Date().toISOString(),
            });
        }
        log.info(`Saved ${companies.length} companies from ${locationLabel} page ${pageNum} (${totalResults} total)`);
    }

    // ── City fallback for provinces with >1200 results ─────────────────────────
    const { enableCityFallback = false } = config;
    if (enableCityFallback && !cityMode && pageNum === 1 && totalResults > 1200) {
        log.info(`${provincia} has ${totalResults} companies (>1200), looking for city links...`);

        const cityUrls = await page.evaluate((prov) => {
            const links = [];
            const seen = new Set();
            // Look for municipio links in the page
            document.querySelectorAll(`a[href*="/provincia/${prov}/municipio/"]`).forEach(a => {
                if (!seen.has(a.href)) {
                    seen.add(a.href);
                    const m = a.href.match(/\/municipio\/([^/?#]+)/);
                    links.push({ url: a.href.replace(/\/?$/, '/'), cityName: m ? m[1] : a.textContent?.trim() });
                }
            });
            return links;
        }, provincia);

        if (cityUrls.length > 0) {
            log.info(`Found ${cityUrls.length} city URLs for ${provincia}`);
            await addRequests(cityUrls.map(c => ({
                url: c.url,
                label: 'LISTING',
                userData: { keyword, provincia, page: 1, cityMode: true, cityName: c.cityName },
            })));
        } else {
            log.warning(`No city links found for ${provincia} — only first 1200 results available`);
        }
    }

    // ── Pagination ─────────────────────────────────────────────────────────────
    const maxPages = config.maxPagesPerProvince || 40;

    if (pageNum < maxPages) {
        // Build next page URL from current URL (strip any existing PgNum)
        const baseUrl = page.url().replace(/\/PgNum-\d+\/?$/, '').replace(/\/$/, '');
        const nextPageUrl = `${baseUrl}/PgNum-${pageNum + 1}/`;

        // Verify that next-page link exists in pagination bar
        const hasNextPage = await page
            .locator(`a[href*="PgNum-${pageNum + 1}"]`)
            .count()
            .catch(() => 0);

        if (hasNextPage > 0) {
            await addRequests([{
                url: nextPageUrl,
                label: 'LISTING',
                userData: { keyword, provincia, page: pageNum + 1, cityMode, cityName },
            }]);
            log.info(`Enqueued ${locationLabel} page ${pageNum + 1}`);
        } else {
            log.info(`No more pages for ${locationLabel} (last: ${pageNum}, total results: ${totalResults})`);
        }
    } else {
        log.info(`Reached maxPagesPerProvince (${maxPages}) for ${locationLabel}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DETAIL handler — individual company profile page
// ─────────────────────────────────────────────────────────────────────────────

router.addHandler('DETAIL', async ({ request, page }) => {
    const { keyword, provincia, page: pageNum, cityMode, cityName, name, description, address, profileUrl } = request.userData;

    await page.waitForSelector('h1, h2', { timeout: 15000 }).catch(() => {});

    const config = await getConfig();
    await handleCaptcha(page, request, config);

    const contacts = await page.evaluate(() => {
        let phone = null, email = null, website = null;

        const telLink = document.querySelector('a[href^="tel:"]');
        if (telLink) {
            phone = telLink.href.replace('tel:', '').trim() || telLink.textContent?.trim() || null;
        } else {
            const m = document.body.textContent?.match(/(?:\+34\s?)?[6789]\d{8}/);
            if (m) phone = m[0].replace(/\s/g, '');
        }

        const mailLink = document.querySelector('a[href^="mailto:"]');
        if (mailLink) {
            email = mailLink.href.replace('mailto:', '').split('?')[0].trim() || null;
        }

        const excluded = ['empresite', 'eleconomista', 'einforma', 'google', 'facebook', 'twitter', 'linkedin', 'youtube', 'instagram'];
        const extLink = [...document.querySelectorAll('a[href^="http"]')].find(a => {
            const h = a.href || '';
            return !excluded.some(x => h.includes(x)) && h.length > 10;
        });
        if (extLink) website = extLink.href;

        return { phone, email, website };
    });

    const { requireWeb = false, requirePhone = false, requireEmail = false, keyword: cfgKeyword } = config;
    if (requireWeb && !contacts.website) return;
    if (requirePhone && !contacts.phone) return;
    if (requireEmail && !contacts.email) return;

    await Dataset.pushData({
        keyword: cfgKeyword || keyword,
        provincia,
        city: cityName || null,
        page: pageNum,
        name,
        description,
        address,
        profileUrl,
        website: contacts.website,
        phone: contacts.phone,
        email: contacts.email,
        scrapedAt: new Date().toISOString(),
    });
});
