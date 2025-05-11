import { listen } from 'listhen'
import { createApp, toNodeListener, appendResponseHeaders, handleCacheHeaders, eventHandler } from 'h3'
import {
    createIPX,
    ipxFSStorage,
    ipxHttpStorage,
    createIPXH3Handler,
} from 'ipx'
import fs from 'fs'
import yaml from 'js-yaml'

interface HttpStorageConfig {
    domains: string[];
}

interface IpxSettingsConfig {
    fsDir: string;
    httpStorage: HttpStorageConfig;
    imageCacheTTLSeconds: number;
}

interface ServerConfig {
    port: number;
}

interface AppConfig {
    ipxSettings: IpxSettingsConfig;
    server: ServerConfig;
}

// --- Default Configuration ---
const DEFAULT_CONFIG: AppConfig = {
    ipxSettings: {
        fsDir: './public',
        httpStorage: {
            domains: ['storage.agrego.id'],
        },
        imageCacheTTLSeconds: 30 * 24 * 3600,
    },
    server: {
        port: 4321,
    },
};

function loadConfig(): AppConfig {
    try {
        const fileContents = fs.readFileSync('./config.yml', 'utf8');
        const loadedConfig = yaml.load(fileContents) as Partial<AppConfig>;
        return {
            server: {
                ...DEFAULT_CONFIG.server,
                ...(loadedConfig.server || {}),
            },
            ipxSettings: {
                ...DEFAULT_CONFIG.ipxSettings,
                ...(loadedConfig.ipxSettings || {}),
                httpStorage: {
                    ...DEFAULT_CONFIG.ipxSettings.httpStorage,
                    ...((loadedConfig.ipxSettings || {}).httpStorage || {}),
                },
            },
        };
    } catch (error) {
        console.warn(`Warning: Could not load config.yml: ${(error as Error).message}. Using default configuration.`);
        return DEFAULT_CONFIG;
    }
}

const config = loadConfig();

// --- IPX Instance ---
const ipx = createIPX({
    storage: ipxFSStorage({ dir: config.ipxSettings.fsDir }),
    httpStorage: ipxHttpStorage({ domains: config.ipxSettings.httpStorage.domains }),
    sharpOptions: { sequentialRead: true },
})

// --- H3 Application ---
const app = createApp()
    .use('/_ipx', eventHandler(async event => {
        const cacheTTL = config.ipxSettings.imageCacheTTLSeconds;
        if (handleCacheHeaders(event, { maxAge: cacheTTL })) {
            return;
        }

        appendResponseHeaders(event, {
            'Cache-Control': `public, max-age=${cacheTTL}, s-maxage=${cacheTTL}, immutable, stale-while-revalidate=600`,
            'Vary': 'Accept-Encoding',
        });

        return createIPXH3Handler(ipx)(event);
    }))
    .use('/health', eventHandler(() => ({ status: 'ok', timestamp: new Date().toISOString() })));


// --- Start Server ---
listen(toNodeListener(app), { port: config.server.port })
console.log(`IPX server listening on http://localhost:${config.server.port}`);