/**
 * Heartbeat module — tracks when the scraper last did useful work.
 * Routes call ping() on every page processed.
 * main.js watchdog reads getLastPing() to decide if we're stuck.
 */

let lastPing = Date.now();

export function ping() {
    lastPing = Date.now();
}

export function getLastPing() {
    return lastPing;
}
