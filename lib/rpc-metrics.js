/**
 * Shared metrics/formatting helpers for eth_getLogs stress tools.
 * Extracted from stress-test.js / heavy-stress-test.js to avoid duplication.
 */

/** Format a byte count into a human-readable string. */
export function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/** Serialized size of a logs array in UTF-8 bytes. */
export function getResponseSize(logs) {
    return Buffer.byteLength(JSON.stringify(logs), 'utf8');
}

/** Left-pad a value to a fixed display width. */
export function padString(str, length) {
    return String(str).padEnd(length);
}

/** Pearson correlation coefficient between two series. */
export function calculateCorrelation(x, y) {
    const n = x.length;
    if (n < 2) return 0;
    const sum1 = x.reduce((a, b) => a + b, 0);
    const sum2 = y.reduce((a, b) => a + b, 0);
    const sum1sq = x.reduce((a, b) => a + b * b, 0);
    const sum2sq = y.reduce((a, b) => a + b * b, 0);
    const pSum = x.reduce((a, b, i) => a + b * y[i], 0);
    const num = pSum - (sum1 * sum2) / n;
    const den = Math.sqrt((sum1sq - (sum1 * sum1) / n) * (sum2sq - (sum2 * sum2) / n));
    return den === 0 ? 0 : num / den;
}
