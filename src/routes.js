import { createPlaywrightRouter, Dataset, log } from 'crawlee';
import { Actor } from 'apify';

export const router = createPlaywrightRouter();

/**
 * LISTING handler - processes a search results page
 * Extracts all companies and enqueues next page if available
 */
router.addHandler('LISTING', async ({ request, page, enqueueLinks }) => {
    const { keyword, provincia, page: pageNum } = request.userData;

    log.info(`Processing: ${provincia} - Page ${pageNum}`);

    // Wait for results to load
    await page.waitForSelector('h3 a', { timeout: 15000 }).catch(() => {});

    // Check if we got a valid results page (not 404 or empty)
    const hasResults = await page.locator('h3 a').count();
    if (hasResults === 0) {
        log.info(`No results on ${provincia} page ${pageNum}, skipping`);
        return;
    }

    // Extract total results count for this province
    const totalText = await page.locator('h2:has-text("Hemos encontrado")').textContent().catch(() => '');
    const totalMatch = totalText?.match(/(\d[\d.]*)/);
    const totalResults = totalMatch ? parseInt(totalMatch[1].replace(/\./g, ''), 10) : 0;

    // Extract all companies from this page
    const companies = await page.evaluate(() => {
        const results = [];
        // Each company card has an h3 with a link
        const cards = document.querySelectorAll('.resultado-busqueda, [class*="resultado"], article');

        // If no specific card container found, try extracting from h3 links directly
        if (cards.length === 0) {
            const h3Links = document.querySelectorAll('h3 a[href*=".html"]');
            h3Links.forEach(link => {
                const card = link.closest('div') || link.parentElement?.parentElement;
                if (!card) return;

                const name = link.textContent?.trim() || '';
                const url = link.href || '';
                const allText = card.textContent || '';

                // Extract description - text after the company name, before the address
                const descEl = card.querySelector('p') || null;
                const description = descEl?.textContent?.trim() || '';

                // Extract address - look for text near map pin icon
                const addressEl = card.querySelector('[class*="map"], [class*="direccion"], [class*="address"]');
                let address = '';
                if (addressEl) {
                    address = addressEl.parentElement?.textContent?.trim() || addressEl.textContent?.trim() || '';
                } else {
                    // Try to extract address from the text pattern (street, CP, city)
                    const addressMatch = allText.match(/(?:Calle|Avenida|Plaza|Paseo|Camino|Carretera|Poligono|Urbanización|Lugar|Ronda|Travesia)[^[VER]*/i);
                    if (addressMatch) {
                        address = addressMatch[0].trim();
                    }
                }

                // Clean up address
                address = address
                    .replace(/Coincidencia encontrada.*/i, '')
                    .replace(/VER EN MAPA/i, '')
                    .replace(/VER FICHA/i, '')
                    .trim();

                if (name && url) {
                    results.push({ name, url, description, address });
                }
            });
        }

        return results;
    });

    // Save results with metadata
    const kvStore = await Actor.openKeyValueStore();
    const config = await kvStore.getValue('CONFIG');

    for (const company of companies) {
        await Dataset.pushData({
            keyword: config?.keyword || keyword,
            provincia,
            page: pageNum,
            name: company.name,
            url: company.url,
            description: company.description,
            address: company.address,
            scrapedAt: new Date().toISOString(),
        });
    }

    log.info(`Extracted ${companies.length} companies from ${provincia} page ${pageNum} (${totalResults} total in province)`);

    // Enqueue next page if available
    const maxPages = (await (await Actor.openKeyValueStore()).getValue('CONFIG'))?.maxPagesPerProvince || 40;

    if (pageNum < maxPages) {
        // Check if there's a next page link (»)
        const hasNextPage = await page.locator('a:has-text("»")').count();

        if (hasNextPage > 0) {
            const nextPageUrl = `https://empresite.eleconomista.es/Actividad/${keyword}/provincia/${provincia}/PgNum-${pageNum + 1}/`;
            await crawler_enqueue(enqueueLinks, nextPageUrl, keyword, provincia, pageNum + 1);
        } else {
            log.info(`No more pages for ${provincia} (stopped at page ${pageNum})`);
        }
    } else {
        log.info(`Reached max pages (${maxPages}) for ${provincia}`);
    }
});

/**
 * Helper to enqueue next page
 */
async function crawler_enqueue(enqueueLinks, url, keyword, provincia, pageNum) {
    await enqueueLinks({
        urls: [url],
        label: 'LISTING',
        userData: {
            keyword,
            provincia,
            page: pageNum,
        },
    });
}
