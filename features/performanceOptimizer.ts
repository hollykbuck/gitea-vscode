/**
 * Simple cache manager for API responses
 * Implements TTL-based cache invalidation
 */
export class CacheManager {
    private cache: Map<string, { value: any, timestamp: number }>;
    private ttl: number;

    constructor(ttl = 10000) { // 10 seconds default
        this.cache = new Map();
        this.ttl = ttl;
    }

    /**
     * Get cached value if valid
     */
    get(key: string) {
        const item = this.cache.get(key);
        if (!item) return null;

        // Check if cache has expired
        if (Date.now() - item.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }

        return item.value;
    }

    /**
     * Set cache value
     */
    set(key: string, value: any) {
        this.cache.set(key, {
            value,
            timestamp: Date.now()
        });
    }

    /**
     * Clear specific key or all cache
     */
    clear(key: string | null = null) {
        if (key) {
            this.cache.delete(key);
        } else {
            this.cache.clear();
        }
    }

    /**
     * Clear expired items
     */
    prune() {
        const now = Date.now();
        for (const [key, item] of this.cache.entries()) {
            if (now - item.timestamp > this.ttl) {
                this.cache.delete(key);
            }
        }
    }
}

/**
 * Debounce utility for throttling frequent calls
 */
export function debounce<T extends (...args: any[]) => any>(func: T, wait: number) {
    let timeout: NodeJS.Timeout | null = null;
    return function executedFunction(...args: Parameters<T>) {
        const later = () => {
            if (timeout) clearTimeout(timeout);
            func(...args);
        };
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Throttle utility for rate-limiting operations
 */
export function throttle<T extends (...args: any[]) => any>(func: T, limit: number) {
    let inThrottle: boolean;
    return function (this: any, ...args: Parameters<T>) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}
