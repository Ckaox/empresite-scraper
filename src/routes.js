import { createPlaywrightRouter, Dataset, log } from 'crawlee';
import { Actor } from 'apify';
import { detectRecaptcha, handleRecaptchaIfPresent } from './captchaSolver.js';
import { ping } from './heartbeat.js';

export const router = createPlaywrightRouter();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getConfig() {
    const kvs = await Actor.openKeyValueStore();
    return await kvs.getValue('CONFIG') ?? {};
}

// ── Progress tracking for in-session pagination (filter mode) ──────────────
// When filters are active, all pagination happens within a single request.
// If CAPTCHA causes a retry (new proxy), we need to know where we left off
// so we can fast-forward and avoid saving duplicate data.

async function getProgress(provincia, keyword) {
    const kvs = await Actor.openKeyValueStore();
    const key = `PROGRESS_${keyword}_${provincia}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    return await kvs.getValue(key) ?? { lastCompletedPage: 0, savedUrls: [] };
}

async function saveProgress(provincia, keyword, lastCompletedPage, savedUrls) {
    const kvs = await Actor.openKeyValueStore();
    const key = `PROGRESS_${keyword}_${provincia}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    await kvs.setValue(key, { lastCompletedPage, savedUrls });
}

/**
 * Click the native empresite filter checkboxes (Web / Email / Teléfono) in the
 * left sidebar and wait for the results list to reload.
 * This pre-filters the listing so only companies tagged by empresite as having
 * that data are returned — no need to visit each profile page for this.
 */
async function applyNativeFilters(page, config) {
    const { requireWeb = false, requirePhone = false, requireEmail = false } = config;
    if (!requireWeb && !requirePhone && !requireEmail) return;

    const filtersToApply = [
        requireWeb     && 'Web',
        requirePhone   && 'Teléfono',
        requireEmail   && 'Email',
    ].filter(Boolean);

    for (const filterName of filtersToApply) {
        try {
            // The sidebar checkboxes are <label> elements whose text starts with the filter name
            // Try multiple selector strategies
            const selectors = [
                `label:has-text("${filterName}")`,
                `input[type="checkbox"] + label:has-text("${filterName}")`,
                `li:has-text("${filterName}") input[type="checkbox"]`,
                `li:has-text("${filterName}") label`,
            ];

            let clicked = false;
            for (const sel of selectors) {
                try {
                    const el = page.locator(sel).first();
                    const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
                    if (!visible) continue;

                    // Check if filter is already active by looking for active filter chips
                    // above the results (e.g. "Web ×", "Email ×")
                    const alreadyActive = await page.evaluate((name) => {
                        // Check for filter chips/badges that indicate the filter is on
                        const allEls = document.querySelectorAll('button, span, a, div, li');
                        for (const el of allEls) {
                            const text = (el.textContent || '').trim();
                            // Active chip pattern: "Web ×" or "Email ×" with close icon
                            if (text.startsWith(name) && (text.includes('×') || text.includes('✕')
                                || el.querySelector('svg, [class*="close"], [class*="remove"]'))) {
                                return true;
                            }
                        }
                        // Also check for checked checkboxes near the filter name
                        const labels = document.querySelectorAll('label');
                        for (const label of labels) {
                            if (!(label.textContent || '').includes(name)) continue;
                            const forId = label.getAttribute('for');
                            const cb = forId
                                ? document.getElementById(forId)
                                : label.previousElementSibling || label.querySelector('input[type="checkbox"]');
                            if (cb && cb.checked) return true;
                        }
                        return false;
                    }, filterName).catch(() => false);

                    if (alreadyActive) {
                        log.debug(`Filter "${filterName}" already active, skipping click`);
                        clicked = true;
                        break;
                    }

                    await el.click({ timeout: 5000 });
                    log.info(`Applied native filter: ${filterName}`);
                    clicked = true;
                    break;
                } catch { /* try next selector */ }
            }

            if (!clicked) {
                log.warning(`Could not find native filter checkbox for "${filterName}" — results will not be pre-filtered`);
            }
        } catch (err) {
            log.warning(`Error applying native filter "${filterName}": ${err.message}`);
        }
    }

    if (filtersToApply.length > 0) {
        // Wait for the results list to reload after clicking filters
        await page.waitForTimeout(2000);
        await page.waitForSelector('h3 a, .g-recaptcha, [data-sitekey]', { timeout: 15000 }).catch(() => {});

        // Verify filters were actually applied by checking for active filter chips
        const activeChips = await page.evaluate(() => {
            const chips = [];
            // Look for filter chips like "Web ×" and "Email ×" shown above results
            document.querySelectorAll('button, span, a, div').forEach(el => {
                const text = (el.textContent || '').trim();
                if ((text.includes('Web') || text.includes('Email') || text.includes('Teléfono'))
                    && (text.includes('×') || text.includes('\u00d7') || el.querySelector('[class*="close"], [class*="remove"], svg'))) {
                    chips.push(text.replace(/\s+/g, ' ').trim());
                }
            });
            return chips;
        });

        if (activeChips.length > 0) {
            log.info(`Filter chips confirmed: ${activeChips.join(', ')}`);
        } else {
            log.warning('Could not verify filter chips — filters may not have been applied correctly');
        }
    }
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
// Helper — extract company cards from the current page DOM
// ─────────────────────────────────────────────────────────────────────────────

async function extractCompanies(page) {
    return page.evaluate(() => {
        const results = [];
        const h3Links = document.querySelectorAll('h3 a[href*=".html"]');

        h3Links.forEach(link => {
            const name = link.textContent?.trim() || '';
            const profileUrl = link.href || '';
            if (!name || !profileUrl) return;

            let card = link.parentElement;
            for (let i = 0; i < 8; i++) {
                if (!card) break;
                if (card.querySelectorAll('h3 a[href*=".html"]').length === 1) break;
                card = card.parentElement;
            }

            let description = '';
            const allPs = Array.from(card?.querySelectorAll('p') || []);
            for (const p of allPs) {
                const t = (p.textContent || '').trim();
                if (t.length > 3
                    && !t.toLowerCase().includes('coincidencia')
                    && !t.toLowerCase().includes('ver en mapa')
                    && !t.toLowerCase().includes('ver ficha')) {
                    description = t;
                    break;
                }
            }

            let address = '';
            const mapPin = card?.querySelector('img[src*="map-pin"]');
            if (mapPin) {
                let node = mapPin.nextSibling;
                const parts = [];
                while (node) {
                    if (node.nodeType === 3) {
                        parts.push(node.textContent.trim());
                    } else if (node.nodeType === 1) {
                        const tag = node.tagName?.toUpperCase();
                        const txt = (node.textContent || '').trim();
                        if (txt.toLowerCase().includes('coincidencia')
                            || txt.toLowerCase().includes('ver en mapa')
                            || txt.toLowerCase().includes('ver ficha')
                            || tag === 'A') break;
                        parts.push(txt);
                    }
                    node = node.nextSibling;
                }
                address = parts.join(' ').replace(/\s{2,}/g, ' ').trim();
            }

            if (!address) {
                const allText = card?.textContent || '';
                const m = allText.match(
                    /(?:Calle|Avenida|Plaza|Paseo|Camino|Carretera|Pol[ií]gono?|Urbanizaci[oó]n|Lugar|Ronda|Traves[ií]a|Barrio|Parque)\s.{5,120}?(\d{5}[^C]*)/i
                );
                if (m) {
                    address = m[0]
                        .replace(/Coincidencia encontrada.*/i, '')
                        .replace(/VER EN MAPA.*/i, '')
                        .replace(/VER FICHA.*/i, '')
                        .replace(/\s{2,}/g, ' ')
                        .trim();
                }
            }

            results.push({ name, profileUrl, description, address });
        });

        return results;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTING handler — search results page
// ─────────────────────────────────────────────────────────────────────────────

router.addHandler('LISTING', async ({ request, page, addRequests }) => {
    const { keyword, provincia, page: pageNum, cityMode = false, cityName = null } = request.userData;
    const locationLabel = cityMode ? `${provincia}/${cityName}` : provincia;

    const config = await getConfig();
    const { scrapeDetails = false, keyword: cfgKeyword, requireWeb = false, requirePhone = false, requireEmail = false, enableCityFallback = false, minCityResults = 20 } = config;
    const filtersActive = requireWeb || requirePhone || requireEmail;
    const maxPages = config.maxPagesPerProvince || 40;

    // ── When filters are active, ALL pagination is done in-session (single request).
    // Navigating directly to /PgNum-N/ resets JS filter state back to page 1.
    // So we only process pageNum===1 and loop through pages via in-page clicks.
    if (filtersActive && pageNum > 1) {
        // This request was enqueued before we knew filters were active — skip it.
        log.info(`Skipping ${locationLabel} page ${pageNum} (handled in-session when filters active)`);
        return;
    }

    log.info(`Processing: ${locationLabel} page ${pageNum}${filtersActive ? ' [in-session pagination mode]' : ''}`);

    await page.waitForSelector('h3 a, .g-recaptcha, [data-sitekey]', { timeout: 20000 }).catch(() => {});
    await handleCaptcha(page, request, config);

    // Apply native sidebar filters ONCE on page 1 (sets JS state for this session).
    // We do NOT re-apply on subsequent pages — re-clicking a filter resets to page 1.
    if (filtersActive) {
        await applyNativeFilters(page, config);
    }

    // ── Load progress (for in-session mode: resume after CAPTCHA/proxy rotation) ──
    const effectiveKeyword = cfgKeyword || keyword;
    const progressKey = cityMode ? `${provincia}_${cityName}` : provincia;
    let progress = filtersActive ? await getProgress(progressKey, effectiveKeyword) : { lastCompletedPage: 0, savedUrls: [] };
    const savedUrlSet = new Set(progress.savedUrls || []);

    if (filtersActive && progress.lastCompletedPage > 0) {
        log.info(`Resuming ${locationLabel} from page ${progress.lastCompletedPage + 1} (${savedUrlSet.size} companies already saved)`);
    }

    // ── Scrape page loop ───────────────────────────────────────────────────────
    // filtersActive  → loop in-session (click pagination links, don't navigate)
    // !filtersActive → scrape current page only, enqueue next page as new request

    let currentPageNum = pageNum;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const hasResults = await page.locator('h3 a').count();
        if (hasResults === 0) {
            log.info(`No results on ${locationLabel} page ${currentPageNum}, stopping`);
            break;
        }

        const totalText = await page.locator('h2').first().textContent().catch(() => '');
        const totalMatch = totalText?.match(/[\d.]+/);
        const totalResults = totalMatch ? parseInt(totalMatch[0].replace(/\./g, ''), 10) : 0;

        const companies = await extractCompanies(page);

        // In filter mode, skip pages we already completed (fast-forward after retry)
        const isAlreadyDone = filtersActive && currentPageNum <= progress.lastCompletedPage;
        if (isAlreadyDone) {
            log.info(`Fast-forwarding past ${locationLabel} page ${currentPageNum} (already saved)`);
        } else {
            // Deduplicate: filter out companies whose profileUrl we already saved
            const newCompanies = filtersActive
                ? companies.filter(c => !savedUrlSet.has(c.profileUrl))
                : companies;

            if (scrapeDetails) {
                if (newCompanies.length > 0) {
                    await addRequests(newCompanies.map(c => ({
                        url: c.profileUrl,
                        label: 'DETAIL',
                        userData: {
                            keyword: effectiveKeyword,
                            provincia,
                            page: currentPageNum,
                            cityMode,
                            cityName,
                            name: c.name,
                            description: c.description,
                            address: c.address,
                            profileUrl: c.profileUrl,
                        },
                    })));
                    log.info(`Enqueued ${newCompanies.length} detail pages from ${locationLabel} page ${currentPageNum}`);
                }
            } else {
                for (const company of newCompanies) {
                    await Dataset.pushData({
                        keyword: effectiveKeyword,
                        provincia,
                        city: cityName || null,
                        page: currentPageNum,
                        name: company.name,
                        description: company.description,
                        address: company.address,
                        profileUrl: company.profileUrl,
                        scrapedAt: new Date().toISOString(),
                    });
                }
                log.info(`Saved ${newCompanies.length} companies from ${locationLabel} page ${currentPageNum} (${totalResults} total)`);
            }

            // Track saved URLs and update progress
            if (filtersActive) {
                for (const c of newCompanies) savedUrlSet.add(c.profileUrl);
                progress.lastCompletedPage = currentPageNum;
                progress.savedUrls = [...savedUrlSet];
                await saveProgress(progressKey, effectiveKeyword, currentPageNum, progress.savedUrls);
            }
        }

        ping();

        // ── City fallback (only on page 1) ──────────────────────────────────────
        if (enableCityFallback && !cityMode && currentPageNum === 1 && totalResults > 1200) {
            log.info(`${provincia} has ${totalResults} companies (>1200), looking for city links...`);

            let cityUrls = await page.evaluate((minCount) => {
                const links = [];
                const seen = new Set();
                document.querySelectorAll('a[href*="/localidad/"]').forEach(a => {
                    if (seen.has(a.href)) return;
                    seen.add(a.href);
                    const text = (a.textContent || '').trim();
                    const countMatch = text.match(/(\d[\d.,\s]*)/);
                    const count = countMatch ? parseInt(countMatch[1].replace(/[^\d]/g, ''), 10) : 0;
                    const m = a.href.match(/\/localidad\/([^/?#]+)/);
                    const slug = m ? m[1] : null;
                    if (slug && count >= minCount) {
                        links.push({ url: a.href.replace(/\/?$/, '/'), cityName: slug, count });
                    }
                });
                return links;
            }, minCityResults);

            if (cityUrls.length === 0) {
                const ubicBtn = page.locator(
                    'button:has-text("Ubicación"), a:has-text("Ubicación"), [title="Ubicación"], .filter-location'
                ).first();
                const clicked = await ubicBtn.click({ timeout: 5000 }).then(() => true).catch(() => false);
                if (clicked) {
                    await page.waitForSelector('a[href*="/localidad/"]', { timeout: 5000 }).catch(() => {});
                    cityUrls = await page.evaluate((minCount) => {
                        const links = [];
                        const seen = new Set();
                        document.querySelectorAll('a[href*="/localidad/"]').forEach(a => {
                            if (seen.has(a.href)) return;
                            seen.add(a.href);
                            const text = (a.textContent || '').trim();
                            const countMatch = text.match(/(\d[\d.,\s]*)/);
                            const count = countMatch ? parseInt(countMatch[1].replace(/[^\d]/g, ''), 10) : 0;
                            const m = a.href.match(/\/localidad\/([^/?#]+)/);
                            const slug = m ? m[1] : null;
                            if (slug && count >= minCount) {
                                links.push({ url: a.href.replace(/\/?$/, '/'), cityName: slug, count });
                            }
                        });
                        return links;
                    }, minCityResults);
                }
            }

            if (cityUrls.length > 0) {
                log.info(`Found ${cityUrls.length} cities for ${provincia} with >=${minCityResults} results each`);
                await addRequests(cityUrls.map(c => ({
                    url: c.url,
                    label: 'LISTING',
                    userData: { keyword, provincia, page: 1, cityMode: true, cityName: c.cityName },
                })));
            } else {
                log.warning(`No city links found for ${provincia} — scraped first 1200 results only`);
            }
        }

        // ── Pagination ──────────────────────────────────────────────────────────
        if (currentPageNum >= maxPages) {
            log.info(`Reached maxPagesPerProvince (${maxPages}) for ${locationLabel}`);
            break;
        }

        const nextPageNum = currentPageNum + 1;

        if (filtersActive) {
            // In-session pagination: click the page link inside the DOM.
            // This preserves the JS filter state set by applyNativeFilters.
            const nextPageLink = page.locator(`a[href*="PgNum-${nextPageNum}"]`).first();
            const hasNextLink = await nextPageLink.count().catch(() => 0);

            if (hasNextLink === 0) {
                log.info(`No more pages for ${locationLabel} (last: ${currentPageNum})`);
                break;
            }

            log.info(`Clicking to ${locationLabel} page ${nextPageNum} (in-session, filter state preserved)`);

            // Human-like delay before clicking next page
            const pageDelay = 2000 + Math.floor(Math.random() * 3000); // 2–5s random
            await page.waitForTimeout(pageDelay);

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
                nextPageLink.click({ timeout: 10000 }),
            ]);
            await page.waitForSelector('h3 a, .g-recaptcha, [data-sitekey]', { timeout: 20000 }).catch(() => {});
            await handleCaptcha(page, request, config);
            currentPageNum = nextPageNum;
        } else {
            // URL-based pagination: enqueue next page as a new crawlee request.
            const baseUrl = page.url().replace(/\/PgNum-\d+\/?$/, '').replace(/\/$/, '');
            const nextPageUrl = `${baseUrl}/PgNum-${nextPageNum}/`;
            const hasNextPage = await page.locator(`a[href*="PgNum-${nextPageNum}"]`).count().catch(() => 0);

            if (hasNextPage > 0) {
                await addRequests([{
                    url: nextPageUrl,
                    label: 'LISTING',
                    userData: { keyword, provincia, page: nextPageNum, cityMode, cityName },
                }]);
                log.info(`Enqueued ${locationLabel} page ${nextPageNum}`);
            } else {
                log.info(`No more pages for ${locationLabel} (last: ${currentPageNum}, total: ${totalResults})`);
            }
            break; // URL-based: one page per handler invocation
        }
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

    // Try to reveal hidden contact data (empresite hides phone/email behind a click)
    const revealSelectors = [
        'button[data-action="reveal"]',
        'button:has-text("Ver teléfono")',
        'button:has-text("Ver email")',
        'button:has-text("Mostrar")',
        'a:has-text("Ver email")',
        'a:has-text("Ver teléfono")',
        '[class*="reveal"]',
        '[class*="show-contact"]',
        '[class*="contact-reveal"]',
        '[data-target*="email"]',
        '[data-track*="email"]',
    ];
    for (const sel of revealSelectors) {
        try {
            const btn = page.locator(sel).first();
            const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
            if (visible) {
                await btn.click({ timeout: 3000 });
                await page.waitForTimeout(1500);
                log.debug(`Clicked reveal button: ${sel}`);
            }
        } catch { /* not found, continue */ }
    }

    const contacts = await page.evaluate(() => {
        let phone = null, email = null, website = null;

        // Phone
        const telLink = document.querySelector('a[href^="tel:"]');
        if (telLink) {
            phone = telLink.href.replace('tel:', '').trim() || telLink.textContent?.trim() || null;
        } else {
            const m = document.body.textContent?.match(/(?:\+34\s?)?[6789]\d{8}/);
            if (m) phone = m[0].replace(/\s/g, '');
        }

        // Email — try mailto: link first, then regex scan on visible text
        const mailLink = document.querySelector('a[href^="mailto:"]');
        if (mailLink) {
            email = mailLink.href.replace('mailto:', '').split('?')[0].trim() || null;
        }
        if (!email) {
            // Scan all text nodes for an email pattern (handles obfuscated/revealed emails)
            const emailMatch = document.body.innerText?.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
            if (emailMatch) email = emailMatch[0];
        }
        if (!email) {
            // Also check data attributes (some sites store email in data-email)
            const dataEmail = document.querySelector('[data-email]')?.getAttribute('data-email');
            if (dataEmail && dataEmail.includes('@')) email = dataEmail;
        }

        // Website
        const excluded = ['empresite', 'eleconomista', 'einforma', 'google', 'facebook', 'twitter', 'linkedin', 'youtube', 'instagram'];
        const extLink = [...document.querySelectorAll('a[href^="http"]')].find(a => {
            const h = a.href || '';
            return !excluded.some(x => h.includes(x)) && h.length > 10;
        });
        if (extLink) website = extLink.href;

        return { phone, email, website };
    });

    log.debug(`DETAIL [${name}] — phone: ${contacts.phone || 'none'}, email: ${contacts.email || 'none'}, web: ${contacts.website || 'none'}`);

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

    // Signal activity for the watchdog
    ping();
});
