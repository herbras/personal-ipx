import { listen } from 'listhen';
import {
    createApp,
    toNodeListener,
    appendResponseHeaders,
    handleCacheHeaders,
    eventHandler,
    sendStream,
    H3Event,
    setResponseHeader,
} from 'h3';
import {
    createIPX,
    ipxFSStorage,
    ipxHttpStorage,
} from 'ipx';
import fsPromises from 'fs/promises';
import fsSync from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import crypto from 'crypto';

// --- TypeScript Interfaces (tetap sama) ---
interface HttpStorageConfig {
    domains: string[];
}

interface IpxSettingsConfig {
    fsDir: string;
    httpStorage: HttpStorageConfig;
    imageCacheTTLSeconds: number;
    diskCacheDir: string;
}

interface ServerConfig {
    port: number;
}

interface AppConfig {
    ipxSettings: IpxSettingsConfig;
    server: ServerConfig;
}

// --- Default Configuration (tetap sama) ---
const DEFAULT_CONFIG: AppConfig = {
    ipxSettings: {
        fsDir: './public',
        httpStorage: {
            domains: [],
        },
        imageCacheTTLSeconds: 30 * 24 * 3600,
        diskCacheDir: './.ipx-cache',
    },
    server: {
        port: 3000,
    },
};

// --- Configuration Loading (tetap sama) ---
function loadConfig(): AppConfig {
    try {
        const fileContents = fsSync.readFileSync('./config.yml', 'utf8');
        const loadedConfig = yaml.load(fileContents) as Partial<AppConfig>;
        const serverConfig = {
            ...DEFAULT_CONFIG.server,
            ...(loadedConfig.server || {}),
        };
        const ipxSettingsConfig = {
            ...DEFAULT_CONFIG.ipxSettings,
            ...(loadedConfig.ipxSettings || {}),
            httpStorage: {
                ...DEFAULT_CONFIG.ipxSettings.httpStorage,
                ...((loadedConfig.ipxSettings || {}).httpStorage || {}),
            },
        };
        if (loadedConfig.ipxSettings?.httpStorage && !Array.isArray(loadedConfig.ipxSettings.httpStorage.domains)) {
            console.warn("Warning: config.yml ipxSettings.httpStorage.domains is not an array. Using default or empty array.");
            ipxSettingsConfig.httpStorage.domains = DEFAULT_CONFIG.ipxSettings.httpStorage.domains;
        }
        return { server: serverConfig, ipxSettings: ipxSettingsConfig };
    } catch (error) {
        console.warn(`Warning: Could not load config.yml: ${(error as Error).message}. Using default configuration.`);
        return DEFAULT_CONFIG;
    }
}

const config = loadConfig();

// --- Setup Disk Cache Directory (tetap sama) ---
const DISK_CACHE_DIR = path.resolve(config.ipxSettings.diskCacheDir);
if (!fsSync.existsSync(DISK_CACHE_DIR)) {
    try {
        fsSync.mkdirSync(DISK_CACHE_DIR, { recursive: true });
        console.log(`Created disk cache directory: ${DISK_CACHE_DIR}`);
    } catch (e) {
        console.error(`Failed to create disk cache directory ${DISK_CACHE_DIR}:`, e);
    }
}

// --- IPX Instance (tetap sama) ---
const ipxInstance = createIPX({
    storage: ipxFSStorage({ dir: config.ipxSettings.fsDir }),
    httpStorage: ipxHttpStorage({ domains: config.ipxSettings.httpStorage.domains }), // Ini tetap dibutuhkan IPX
    sharpOptions: { sequentialRead: true },
});

// --- Helper Functions ---
async function generateFileOrStringHash(input: string, isFilePath: boolean = true): Promise<string | null> {
    try {
        let buffer: Buffer;
        if (isFilePath) {
            buffer = await fsPromises.readFile(input);
        } else {
            buffer = Buffer.from(input, 'utf-8');
        }
        return crypto.createHash('sha256').update(buffer).digest('hex');
    } catch (err) {
        console.warn(`Could not generate hash for ${input}: ${(err as Error).message}`);
        return null;
    }
}

function sanitizeForFilePath(name: string): string {
    // Hapus skema, ganti karakter non-alphanumeric (kecuali titik, underscore, minus) dengan underscore
    // Ini sederhana, mungkin perlu lebih robus untuk kasus yang sangat kompleks
    return name.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function parseModifiersString(modifiersStr: string): Record<string, string> {
    const modifiers: Record<string, string> = {};
    if (!modifiersStr || modifiersStr === '_' || modifiersStr.trim() === '') {
        return modifiers;
    }

    modifiersStr.split(',').forEach(part => {
        const trimmedPart = part.trim();
        if (!trimmedPart) return;

        const firstUnderscoreIndex = trimmedPart.indexOf('_');
        if (firstUnderscoreIndex === -1) {
            // Modifier without a value, e.g., "grayscale"
            modifiers[trimmedPart] = 'true'; // IPX convention for boolean-like flags often implies a string "true" or empty string
        } else {
            const key = trimmedPart.substring(0, firstUnderscoreIndex);
            const value = trimmedPart.substring(firstUnderscoreIndex + 1);
            modifiers[key] = value;
        }
    });
    return modifiers;
}

// --- H3 Application ---
const app = createApp();

// IPX Cache Handler
app.use('/_ipx/**', eventHandler(async (event: H3Event) => {
    const reqUrl = event.node.req.url || '';
    const ipxRequestPath = reqUrl.substring('/_ipx/'.length); // Ini adalah "[modifiers]/[source_url_or_path]"

    if (!ipxRequestPath || ipxRequestPath.endsWith('/') || ipxRequestPath.includes('.sourcehash')) {
        event.node.res.statusCode = 400;
        return 'Invalid IPX request path format.';
    }

    const parts = ipxRequestPath.split('/');
    const modifiers = parts.shift() || '_';
    let rawSourceIdentifier = parts.join('/'); // Ini bisa berupa path relatif ATAU URL absolut

    if (!rawSourceIdentifier) {
        event.node.res.statusCode = 400;
        return 'Missing source identifier in IPX URL.';
    }

    let effectiveSourceForIpx: string = rawSourceIdentifier;
    let isHttpSourceByOverride: boolean = false;
    let originalHttpUrlForHashing: string | null = null; // Untuk hashing jika sumbernya URL
    let originalImageAbsolutePathForFs: string | null = null; // Untuk sumber dari FS

    // Deteksi jika rawSourceIdentifier adalah URL absolut
    if (rawSourceIdentifier.startsWith('http://') || rawSourceIdentifier.startsWith('https://')) {
        originalHttpUrlForHashing = rawSourceIdentifier; // Simpan URL asli untuk hashing cache
        try {
            const urlObject = new URL(rawSourceIdentifier);
            const domain = urlObject.hostname;

            // KEAMANAN: Periksa apakah domain ini diizinkan
            if (config.ipxSettings.httpStorage.domains.includes(domain)) {
                // IPX HttpStorage mengharapkan path *setelah* domain.
                // Untuk kasus ini, kita bisa memberikan URL lengkap jika IPX HttpStorage bisa menanganinya,
                // atau kita ekstrak path-nya. Untuk konsistensi dengan cara kerja IPX,
                // lebih baik kita berikan path relatif terhadap domain yang cocok.
                effectiveSourceForIpx = urlObject.pathname.substring(1) + urlObject.search; // path setelah domain
                isHttpSourceByOverride = true;
                console.log(`[URL OVERRIDE] Allowed remote URL: ${rawSourceIdentifier}. Effective IPX source: ${effectiveSourceForIpx} for domain: ${domain}`);
            } else {
                console.warn(`[URL DENIED] Remote URL domain not allowed: ${domain} from ${rawSourceIdentifier}`);
                event.node.res.statusCode = 403;
                return `Fetching from domain ${domain} is not allowed.`;
            }
        } catch (e) {
            console.warn(`[URL ERROR] Invalid URL format in source: ${rawSourceIdentifier}`);
            event.node.res.statusCode = 400;
            return `Invalid URL format: ${rawSourceIdentifier}`;
        }
    } else {
        // Jika bukan URL absolut, anggap sebagai path relatif untuk fsDir
        effectiveSourceForIpx = rawSourceIdentifier;
        originalImageAbsolutePathForFs = path.resolve(config.ipxSettings.fsDir, effectiveSourceForIpx);
    }

    // Bangun path cache. Kita perlu identifier unik untuk cache.
    // Jika sumbernya URL, ipxRequestPath bisa sangat panjang dan aneh.
    // Mari buat identifier cache yang lebih bersih: hash dari (modifiers + originalHttpUrl) atau (modifiers + fsPath)
    let cacheKeyContent: string;
    let cacheFileBaseName: string;

    if (isHttpSourceByOverride && originalHttpUrlForHashing) {
        cacheKeyContent = modifiers + "::URL::" + originalHttpUrlForHashing;
        // Buat nama file yang lebih ramah dari URL (opsional, bisa juga hash dari URL asli)
        cacheFileBaseName = sanitizeForFilePath(originalHttpUrlForHashing);
    } else {
        cacheKeyContent = modifiers + "::FS::" + effectiveSourceForIpx;
        cacheFileBaseName = effectiveSourceForIpx.replace(/\//g, '_'); // Ganti slash agar tidak jadi subdirektori
    }
    
    const cacheKeyHash = crypto.createHash('sha256').update(cacheKeyContent).digest('hex').substring(0, 16);
    // Struktur cache: DISK_CACHE_DIR / [modifiers_sanitized] / [cacheKeyHash] / [original_basename_sanitized_or_hash_ext]
    // Atau lebih sederhana: DISK_CACHE_DIR / [cacheKeyHash] / [modifiers_sanitized]_[basename_sanitized_ext]
    // Kita pilih yang lebih sederhana untuk awal:
    const sanitizedModifiers = sanitizeForFilePath(modifiers);
    const finalCacheFileName = `${sanitizedModifiers}_${cacheFileBaseName}`; // Ini bisa sangat panjang
    // Alternatif: gunakan hash dari URL/path asli sebagai nama file, dan modifiers sebagai bagian dari direktori
    const cachedImageFileName = `${cacheKeyHash}.img`; // Nama file cache akan selalu hash + .img
    const cachedImagePath = path.resolve(DISK_CACHE_DIR, modifiers, cachedImageFileName); // Cache path: .ipx-cache/[modifiers]/[hash].img
    const hashFilePath = `${cachedImagePath}.sourcehash`; // Menyimpan hash dari SUMBER ASLI (file lokal atau URL)

    // Validasi path cache (setelah dibentuk)
    const normalizedCacheDir = path.normalize(DISK_CACHE_DIR);
    const normalizedCachedImagePath = path.normalize(cachedImagePath);
    if (!normalizedCachedImagePath.startsWith(normalizedCacheDir + path.sep) || normalizedCachedImagePath === normalizedCacheDir) {
        console.error(`Security Alert: Cache path traversal attempt for "${ipxRequestPath}". Denying access.`);
        event.node.res.statusCode = 403;
        return 'Access Denied (cache path).';
    }

    // Pastikan direktori untuk file cache ada
    const cacheFileDir = path.dirname(cachedImagePath);
    if (!fsSync.existsSync(cacheFileDir)) {
        try {
            fsSync.mkdirSync(cacheFileDir, { recursive: true });
        } catch (mkdirError) {
            if (!fsSync.existsSync(cacheFileDir)) {
                console.error(`Failed to create cache directory ${cacheFileDir}:`, mkdirError);
                event.node.res.statusCode = 500;
                return "Server error creating cache directory.";
            }
        }
    }

    // Logika Cache Check
    let sourceExistsForHashing = false;
    if (isHttpSourceByOverride) {
        sourceExistsForHashing = true; // Kita asumsikan URL valid jika sudah lolos cek domain
    } else if (originalImageAbsolutePathForFs) {
        sourceExistsForHashing = fsSync.existsSync(originalImageAbsolutePathForFs);
    }

    if (sourceExistsForHashing) {
        if (fsSync.existsSync(cachedImagePath) && fsSync.existsSync(hashFilePath)) {
            try {
                const storedSourceHash = await fsPromises.readFile(hashFilePath, 'utf-8');
                let currentSourceHash: string | null = null;

                if (isHttpSourceByOverride && originalHttpUrlForHashing) {
                    // Untuk URL, hashnya adalah URL itu sendiri. Perubahan URL berarti sumber baru.
                    // Jika kita ingin mendeteksi perubahan konten URL, kita perlu ETag atau Last-Modified (lebih kompleks)
                    // Untuk sekarang, kita hash URL-nya saja sebagai identifier.
                    currentSourceHash = await generateFileOrStringHash(originalHttpUrlForHashing, false);
                } else if (originalImageAbsolutePathForFs) {
                    currentSourceHash = await generateFileOrStringHash(originalImageAbsolutePathForFs, true);
                }

                if (currentSourceHash && storedSourceHash === currentSourceHash) {
                    console.log(`[CACHE HIT] Serving from disk: ${cachedImagePath} for source ${isHttpSourceByOverride ? originalHttpUrlForHashing : effectiveSourceForIpx}`);
                    appendResponseHeaders(event, {
                        'Cache-Control': `public, max-age=${config.ipxSettings.imageCacheTTLSeconds}, immutable`,
                        'X-IPX-Disk-Cache': 'HIT',
                    });
                    return sendStream(event, fsSync.createReadStream(cachedImagePath));
                }
                console.log(`[CACHE STALE] Hashes mismatch for: ${cachedImagePath}`);
            } catch (err) {
                console.warn(`[CACHE ERROR] Error reading cache/hash for ${cachedImagePath}: ${(err as Error).message}`);
            }
        } else {
            console.log(`[CACHE MISS] Not found in disk cache: ${cachedImagePath}`);
        }
    } else if (!isHttpSourceByOverride) { // Hanya jika FS source dan tidak ditemukan
        console.warn(`[IPX PROCESS] Original image ${originalImageAbsolutePathForFs} not in fsDir. IPX will attempt to resolve (should 404 if not HTTP).`);
        // Biarkan IPX memproses dan kemungkinan menghasilkan 404 jika sumber tidak ditemukan
    }


    // Cache Miss / Stale / Sumber HTTP: Proses dengan IPX, simpan ke cache, lalu kirim
    console.log(`[IPX PROCESS] Source: ${effectiveSourceForIpx} (Origin: ${isHttpSourceByOverride ? originalHttpUrlForHashing : 'FS'}) with modifiers: ${modifiers}`);
    try {
        // ipxInstance akan menggunakan httpStorage jika effectiveSourceForIpx adalah path relatif dan domainnya cocok,
        // atau fsStorage jika pathnya ada di fsDir.
        const parsedModifiers = parseModifiersString(modifiers);
        const imageHandler = ipxInstance(effectiveSourceForIpx, parsedModifiers);
        const processedImage = await imageHandler.process();
        const imageData = processedImage.data;

        // Simpan ke cache disk jika sumbernya valid untuk di-cache (FS atau HTTP yang diizinkan)
        if (sourceExistsForHashing) { // Hanya cache jika kita punya sumber asli untuk di-hash
            await fsPromises.writeFile(cachedImagePath, imageData);
            let newSourceHash: string | null = null;
            if (isHttpSourceByOverride && originalHttpUrlForHashing) {
                newSourceHash = await generateFileOrStringHash(originalHttpUrlForHashing, false);
            } else if (originalImageAbsolutePathForFs) {
                newSourceHash = await generateFileOrStringHash(originalImageAbsolutePathForFs, true);
            }

            if (newSourceHash) {
                await fsPromises.writeFile(hashFilePath, newSourceHash);
            }
            console.log(`[CACHE WRITE] Cached to disk: ${cachedImagePath}`);
        }

        const contentType = processedImage.format ? `image/${processedImage.format}` : 'application/octet-stream';
        setResponseHeader(event, 'Content-Type', contentType);
        appendResponseHeaders(event, {
            'Cache-Control': `public, max-age=${config.ipxSettings.imageCacheTTLSeconds}, immutable`, // Atau bisa juga header dari IPX jika lebih sesuai
            'X-IPX-Disk-Cache': sourceExistsForHashing ? 'MISS_AND_STORED' : 'BYPASS_NO_SOURCE_HASH',
        });

        return imageData;

    } catch (error: any) {
        console.error(`[IPX ERROR] IPX processing or caching failed for "${ipxRequestPath}":`, error.message);
        event.node.res.statusCode = error.statusCode || 500;
        return error.message || 'Error processing image.';
    }
}));

app.use('/health', eventHandler(() => ({ status: 'ok', timestamp: new Date().toISOString() })));

// --- Start Server (tetap sama) ---
listen(toNodeListener(app), { port: config.server.port })
    .then(() => {
        console.log("-------------------------------------------------------");
        console.log(`IPX Server Configuration:`);
        console.log(`  Port: ${config.server.port}`);
        console.log(`  FS Storage Directory (fsDir): ${path.resolve(config.ipxSettings.fsDir)}`);
        console.log(`  HTTP Storage Domains (Allowed for URL Override): ${config.ipxSettings.httpStorage.domains.join(', ') || 'N/A'}`);
        console.log(`  Disk Cache Directory: ${DISK_CACHE_DIR}`);
        console.log(`  Default Image Cache TTL: ${config.ipxSettings.imageCacheTTLSeconds} seconds`);
        console.log("-------------------------------------------------------");
        console.log(`IPX server listening on http://localhost:${config.server.port}`);
        console.log("  - To use FS source: /_ipx/[modifiers]/path/to/image.jpg");
        console.log("  - To use HTTP source (URL override): /_ipx/[modifiers]/https://allowed.domain.com/path/to/image.png");
        console.log("-------------------------------------------------------");
    })
    .catch(err => {
        console.error("Failed to start server:", err);
        process.exit(1);
    });