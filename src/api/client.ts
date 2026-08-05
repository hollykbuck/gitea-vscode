import { CacheManager } from '../features/performanceOptimizer';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
    method?: HttpMethod;
    headers?: Record<string, string>;
    body?: unknown;
}

/**
 * Minimal authenticated HTTP client for the Gitea REST API.
 *
 * Replaces the hand-rolled https/http request code with the global `fetch`
 * API, keeps the TTL cache and transparent pagination behaviour of the
 * original implementation, and returns strongly-typed results.
 */
export class GiteaClient {
    private instanceUrl: string;
    private authToken: string;
    private readonly cache = new CacheManager<unknown>(1000);

    constructor(instanceUrl: string, authToken: string) {
        this.instanceUrl = instanceUrl;
        this.authToken = authToken;
    }

    /**
     * Update the credentials used by this client.
     */
    setCredentials(instanceUrl: string, authToken: string): void {
        this.instanceUrl = instanceUrl;
        this.authToken = authToken;
        this.cache.clear();
    }

    getInstanceUrl(): string {
        return this.instanceUrl;
    }

    getAuthToken(): string {
        return this.authToken;
    }

    isConfigured(): boolean {
        return Boolean(this.instanceUrl && this.authToken);
    }

    clearCache(): void {
        this.cache.clear();
    }

    /**
     * Make an authenticated request to the Gitea API. GET requests are cached
     * (TTL 1s) and, when the response is an array carrying an `x-total-count`
     * header, all pages are fetched transparently.
     *
     * @param endpoint API endpoint (e.g. '/api/v1/user')
     * @param options  Request options
     */
    async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
        if (!this.isConfigured()) {
            throw new Error('Gitea not configured. Please run "Gitea: Configure Instance"');
        }

        const method = options.method ?? 'GET';
        const cacheKey = `${this.instanceUrl}${endpoint}`;

        if (method === 'GET') {
            const cached = this.cache.get(cacheKey);
            if (cached) {
                return cached as T;
            }
        }

        return this.fetchAllPages<T>(endpoint, options, method, 1, []);
    }

    /**
     * Fetch a URL with authentication and return the raw response body as a
     * Buffer. Unlike {@link request} this does not parse JSON, so it works for
     * binary assets such as issue attachments and embedded images.
     */
    async fetchBinary(url: string): Promise<Buffer> {
        if (!this.authToken) {
            throw new Error('Gitea not configured');
        }

        const response = await fetch(new URL(url), {
            method: 'GET',
            headers: { 'Authorization': `token ${this.authToken}` },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} fetching ${url}`);
        }

        return Buffer.from(await response.arrayBuffer());
    }

    private async fetchAllPages<T>(
        endpoint: string,
        options: RequestOptions,
        method: HttpMethod,
        page: number,
        accumulated: T[],
    ): Promise<T> {
        const separator = endpoint.includes('?') ? '&' : '?';
        const pagedEndpoint = `${endpoint}${separator}page=${page}`;
        const url = new URL(pagedEndpoint, this.instanceUrl);

        const response = await fetch(url, {
            method,
            headers: {
                'Authorization': `token ${this.authToken}`,
                'Content-Type': 'application/json',
                ...options.headers,
            },
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });

        if (!response.ok) {
            const text = await response.text();
            const errorBody = text.length > 200 ? `${text.substring(0, 200)}…` : text;
            throw new Error(`API request failed with status ${response.status}: ${errorBody}`);
        }

        const rawText = await response.text();
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawText);
        } catch {
            // Non-JSON payload (e.g. raw .diff text)
            return rawText as unknown as T;
        }

        const cacheKey = `${this.instanceUrl}${endpoint}`;
        const totalCount = response.headers.get('x-total-count');

        if (method === 'GET' && Array.isArray(parsed) && totalCount) {
            const total = parseInt(totalCount, 10);
            const allData = accumulated.concat(parsed as T[]);
            if (allData.length < total) {
                return this.fetchAllPages<T>(endpoint, options, method, page + 1, allData);
            }
            this.cache.set(cacheKey, allData);
            return allData as T;
        }

        if (method === 'GET') {
            this.cache.set(cacheKey, parsed);
        }

        return parsed as T;
    }
}
