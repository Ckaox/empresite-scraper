import { log } from 'crawlee';

const TWOCAPTCHA_IN = 'https://2captcha.com/in.php';
const TWOCAPTCHA_RES = 'https://2captcha.com/res.php';

/**
 * Detect if the page has a reCAPTCHA challenge
 * @param {import('playwright').Page} page
 * @returns {{ found: boolean, siteKey: string|null, isV3: boolean }}
 */
export async function detectRecaptcha(page) {
    return page.evaluate(() => {
        // Check for reCAPTCHA v2 widget
        const recaptchaDiv = document.querySelector('.g-recaptcha, [data-sitekey]');
        if (recaptchaDiv) {
            return {
                found: true,
                siteKey: recaptchaDiv.getAttribute('data-sitekey'),
                isV3: false,
            };
        }

        // Check for reCAPTCHA iframe
        const iframe = document.querySelector('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]');
        if (iframe) {
            const src = iframe.getAttribute('src') || '';
            const keyMatch = src.match(/[?&]k=([^&]+)/);
            return {
                found: true,
                siteKey: keyMatch ? keyMatch[1] : null,
                isV3: src.includes('anchor'),
            };
        }

        // Check for recaptcha script tag
        const script = document.querySelector('script[src*="recaptcha"]');
        if (script) {
            const src = script.getAttribute('src') || '';
            const renderMatch = src.match(/render=([^&]+)/);
            return {
                found: true,
                siteKey: renderMatch ? renderMatch[1] : null,
                isV3: !!renderMatch,
            };
        }

        // Check for captcha container by common class/id names
        const captchaEl = document.querySelector('#captcha, .captcha, #recaptcha, .recaptcha');
        if (captchaEl) {
            return { found: true, siteKey: null, isV3: false };
        }

        return { found: false, siteKey: null, isV3: false };
    });
}

/**
 * Solve reCAPTCHA using 2Captcha service
 * @param {object} opts
 * @param {string} opts.apiKey - 2Captcha API key
 * @param {string} opts.siteKey - reCAPTCHA site key
 * @param {string} opts.pageUrl - URL of the page with CAPTCHA
 * @param {boolean} [opts.isV3=false] - Whether it's reCAPTCHA v3
 * @param {string} [opts.action] - Action for v3
 * @returns {Promise<string>} Solution token
 */
export async function solveCaptcha2Captcha({ apiKey, siteKey, pageUrl, isV3 = false, action = 'verify' }) {
    if (!apiKey) throw new Error('2Captcha API key not provided');
    if (!siteKey) throw new Error('reCAPTCHA site key not found on page');

    log.info(`Sending reCAPTCHA to 2Captcha (siteKey: ${siteKey.substring(0, 10)}...)`);

    // --- Step 1: Submit captcha ---
    const inParams = new URLSearchParams({
        key: apiKey,
        method: 'userrecaptcha',
        googlekey: siteKey,
        pageurl: pageUrl,
        json: '1',
    });

    if (isV3) {
        inParams.set('version', 'v3');
        inParams.set('action', action);
        inParams.set('min_score', '0.3');
    }

    const submitRes = await fetch(`${TWOCAPTCHA_IN}?${inParams}`);
    const submitData = await submitRes.json();

    if (submitData.status !== 1) {
        throw new Error(`2Captcha submit error: ${submitData.request}`);
    }

    const captchaId = submitData.request;
    log.info(`2Captcha task submitted (ID: ${captchaId}), waiting for solution...`);

    // --- Step 2: Poll for solution ---
    const resParams = new URLSearchParams({
        key: apiKey,
        action: 'get',
        id: captchaId,
        json: '1',
    });

    const maxAttempts = 60; // 5 minutes max (60 × 5s)
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds

        const pollRes = await fetch(`${TWOCAPTCHA_RES}?${resParams}`);
        const pollData = await pollRes.json();

        if (pollData.status === 1) {
            log.info('reCAPTCHA solved successfully!');
            return pollData.request; // This is the g-recaptcha-response token
        }

        if (pollData.request !== 'CAPCHA_NOT_READY') {
            throw new Error(`2Captcha solve error: ${pollData.request}`);
        }

        if (i % 6 === 0) {
            log.info(`Still waiting for 2Captcha solution... (${(i * 5)}s elapsed)`);
        }
    }

    throw new Error('2Captcha timeout: solution not received within 5 minutes');
}

/**
 * Inject the solved CAPTCHA token into the page and trigger submission
 * @param {import('playwright').Page} page
 * @param {string} token - The solved g-recaptcha-response token
 */
export async function injectCaptchaToken(page, token) {
    await page.evaluate((solvedToken) => {
        // Set the response in the hidden textarea
        const responseEls = document.querySelectorAll('[name="g-recaptcha-response"], #g-recaptcha-response');
        responseEls.forEach(el => {
            el.value = solvedToken;
            el.innerHTML = solvedToken;
            // Make visible for debugging (style might be display:none)
        });

        // Try to trigger the reCAPTCHA callback
        if (typeof window.___grecaptcha_cfg !== 'undefined') {
            const clients = window.___grecaptcha_cfg?.clients;
            if (clients) {
                Object.values(clients).forEach(client => {
                    // Traverse the client object tree to find the callback
                    const findCallback = (obj, depth = 0) => {
                        if (depth > 5 || !obj) return;
                        for (const key of Object.keys(obj)) {
                            if (typeof obj[key] === 'function' && key.length < 5) {
                                try { obj[key](solvedToken); } catch {}
                            } else if (typeof obj[key] === 'object') {
                                findCallback(obj[key], depth + 1);
                            }
                        }
                    };
                    findCallback(client);
                });
            }
        }

        // Also try the global grecaptcha callback  
        if (typeof window.grecaptcha !== 'undefined') {
            try { window.grecaptcha?.execute?.(); } catch {}
        }

        // Try submitting the form if there's one wrapping the captcha
        const form = document.querySelector('form:has(.g-recaptcha), form:has([name="g-recaptcha-response"])');
        if (form) {
            form.submit();
        }
    }, token);

    // Wait for navigation after captcha submission
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

/**
 * Full reCAPTCHA detection + solving pipeline
 * @param {import('playwright').Page} page
 * @param {string} apiKey - 2Captcha API key
 * @returns {{ solved: boolean, hadCaptcha: boolean }}
 */
export async function handleRecaptchaIfPresent(page, apiKey) {
    const detection = await detectRecaptcha(page);

    if (!detection.found) {
        return { solved: false, hadCaptcha: false };
    }

    log.warning(`reCAPTCHA detected on ${page.url()}`);

    if (!apiKey) {
        log.error('reCAPTCHA found but no 2Captcha API key configured! Set captchaApiKey in input.');
        return { solved: false, hadCaptcha: true };
    }

    if (!detection.siteKey) {
        log.error('reCAPTCHA found but could not extract site key from page');
        return { solved: false, hadCaptcha: true };
    }

    try {
        const token = await solveCaptcha2Captcha({
            apiKey,
            siteKey: detection.siteKey,
            pageUrl: page.url(),
            isV3: detection.isV3,
        });

        await injectCaptchaToken(page, token);
        log.info('reCAPTCHA token injected, page should reload/continue');

        return { solved: true, hadCaptcha: true };
    } catch (error) {
        log.error(`Failed to solve reCAPTCHA: ${error.message}`);
        return { solved: false, hadCaptcha: true };
    }
}
