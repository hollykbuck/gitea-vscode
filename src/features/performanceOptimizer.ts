/**
 * Simple cache manager for API responses with TTL-based invalidation.
 */
export class CacheManager<T> {
    private readonly cache = new Map<string, { value: T; timestamp: number }>();
    private readonly ttl: number;

    constructor(ttl = 10000) {
        this.ttl = ttl;
    }

    /**
     * Get cached value if valid, otherwise null.
     */
    get(key: string): T | null {
        const item = this.cache.get(key);
        if (!item) return null;

        if (Date.now() - item.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }

        return item.value;
    }

    /**
     * Set a cached value.
     */
    set(key: string, value: T): void {
        this.cache.set(key, { value, timestamp: Date.now() });
    }

    /**
     * Clear a specific key or the whole cache.
     */
    clear(key?: string): void {
        if (key) {
            this.cache.delete(key);
        } else {
            this.cache.clear();
        }
    }

    /**
     * Remove expired entries.
     */
    prune(): void {
        const now = Date.now();
        for (const [key, item] of this.cache.entries()) {
            if (now - item.timestamp > this.ttl) {
                this.cache.delete(key);
            }
        }
    }
}

/**
 * Debounce utility for throttling frequent calls.
 */
export function debounce<A extends unknown[]>(func: (...args: A) => void, wait: number): (...args: A) => void {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return function executedFunction(...args: A) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Throttle utility for rate-limiting operations (leading edge).
 */
export function throttle<A extends unknown[]>(func: (...args: A) => void, limit: number): (...args: A) => void {
    let inThrottle = false;
    return function throttled(this: unknown, ...args: A) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => {
                inThrottle = false;
            }, limit);
        }
    };
}
