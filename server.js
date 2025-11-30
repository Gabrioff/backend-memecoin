const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Octokit } = require('octokit');

// --- ESCUDO ANTI-CAÍDAS (Importación segura) ---
let fetch;
try {
    fetch = require('node-fetch');
} catch (e) {
    console.warn("⚠️ node-fetch no encontrado, intentando usar fetch nativo...");
    fetch = global.fetch;
}

// --- ESCUDO ANTI-MUERTE (Global Error Handlers) ---
// Esto evita que el bot se apague si hay un error desconocido
process.on('uncaughtException', (err) => {
    console.error('🔥 ERROR CRÍTICO (No capturado):', err.message);
    console.error('   -> El bot sigue vivo. No te preocupes.');
    // No hacemos process.exit() para que NO se pare
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 PROMESA RECHAZADA (Sin manejo):', reason);
    // No hacemos process.exit()
});

const app = express();
// Railway asigna un puerto en la variable PORT. Si no existe, usa 3000.
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN ---
const GITHUB_OWNER = "Gabrioff"; 
const GITHUB_REPO = "backend-memecoin"; 
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Validación suave: Si falta el token, avisamos pero NO matamos el servidor inmediatamente
// para que puedas ver el log en Railway sin que diga "Crashed".
if (!GITHUB_TOKEN) {
    console.error("❌ OJO: Falta GITHUB_TOKEN. El guardado fallará, pero el server arranca.");
}

const octokit = new Octokit({ 
    auth: GITHUB_TOKEN,
    request: { fetch: fetch },
    log: { debug: () => {}, info: () => {}, warn: console.warn, error: console.error }
});

app.use(cors({ origin: '*' }));
app.use(bodyParser.json({ limit: '50mb' }));

// --- MEMORIA ---
const collections = {
    users: { path: "data/users.json", data: {}, sha: null, dirty: false },
    tokens: { path: "data/tokens.json", data: {}, sha: null, dirty: false },
    bots: { path: "data/bots.json", data: [], sha: null, dirty: false },
    transfers: { path: "data/transfers.json", data: [], sha: null, dirty: false }
};

let isSaving = false;

// --- 1. CARGA EN SEGUNDO PLANO ---
async function initStorage() {
    console.log(`🔌 [CONECTANDO] Repo: ${GITHUB_OWNER}/${GITHUB_REPO}`);
    
    // Usamos map para no bloquear si uno falla
    const promises = Object.keys(collections).map(async (key) => {
        const col = collections[key];
        try {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner: GITHUB_OWNER, repo: GITHUB_REPO, path: col.path,
                headers: { 'X-GitHub-Api-Version': '2022-11-28' }
            });
            col.sha = data.sha;
            // Protección extra contra JSON corrupto
            try {
                col.data = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
                console.log(`   ✅ CARGADO: ${key}`);
            } catch (jsonErr) {
                console.warn(`   ⚠️ JSON ROTO en ${key}. Reiniciando archivo.`);
                col.data = (key === 'bots' || key === 'transfers') ? [] : {};
                col.dirty = true;
            }
        } catch (error) {
            const status = error.status || (error.response ? error.response.status : null);
            if (status === 404) {
                console.log(`   🆕 CREANDO: ${key}`);
                col.dirty = true;
                col.data = (key === 'bots' || key === 'transfers') ? [] : {};
            } else {
                console.error(`   ⚠️ ERROR CARGA ${key}: ${error.message}`);
            }
        }
    });
    // No hacemos 'await' global aquí para no retrasar el inicio del servidor
}

// --- 2. GUARDADO BLINDADO ---
async function saveLoop() {
    if (isSaving) return;
    const dirtyKeys = Object.keys(collections).filter(k => collections[k].dirty);
    if (dirtyKeys.length === 0) return;

    isSaving = true;
    for (const key of dirtyKeys) {
        const col = collections[key];
        try {
            console.log(`💾 GUARDANDO: ${key}...`);
            const contentEncoded = Buffer.from(JSON.stringify(col.data, null, 2)).toString('base64');
            
            const res = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
                owner: GITHUB_OWNER, repo: GITHUB_REPO, path: col.path,
                message: `Auto-save ${key}`, content: contentEncoded, sha: col.sha
            });
            col.sha = res.data.content.sha;
            col.dirty = false;
            console.log(`   ✅ OK: ${key}`);
        } catch (error) {
            console.error(`   ❌ FALLÓ GUARDADO ${key}: ${error.message}`);
            // Auto-recuperación de conflictos
            if (error.status === 409) {
                try {
                    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                        owner: GITHUB_OWNER, repo: GITHUB_REPO, path: col.path
                    });
                    col.sha = data.sha;
                } catch(e) {}
            }
        }
    }
    isSaving = false;
}

// --- API ---
app.get('/', (req, res) => res.send('Zombie Server Online 🧟‍♂️'));

app.get('/api/load', (req, res) => {
    try {
        res.json({ 
            success: true, 
            data: {
                users: collections.users.data,
                tokens: collections.tokens.data,
                bots: collections.bots.data,
                transfers: collections.transfers.data,
                chat: [] 
            }
        });
    } catch (e) {
        console.error("Error en /api/load:", e);
        res.status(500).json({ error: "Internal Error" });
    }
});

app.post('/api/stream', (req, res) => {
    try {
        const { data } = req.body;
        if (!data) return res.json({ success: false });

        if (data.users) {
            Object.keys(data.users).forEach(u => {
                const inc = data.users[u];
                const ext = collections.users.data[u];
                if (!ext || JSON.stringify(ext) !== JSON.stringify(inc)) {
                    collections.users.data[u] = { ...(ext || {}), ...inc };
                    collections.users.dirty = true;
                }
            });
        }
        if (data.tokens) {
            Object.keys(data.tokens).forEach(tid => {
                const inc = data.tokens[tid];
                const ext = collections.tokens.data[tid];
                if (!ext) {
                    collections.tokens.data[tid] = inc;
                    collections.tokens.dirty = true;
                } else {
                    ext.marketCap = inc.marketCap;
                    ext.price = inc.price;
                    ext.liquidityDepth = inc.liquidityDepth;
                    ext.conviction = inc.conviction; // IMPORTANTE: Sincronizar conviction
                    ext.quality = inc.quality;       // IMPORTANTE: Sincronizar quality
                    if(inc.holders) ext.holders = inc.holders;
                    if(inc.chartData) ext.chartData = inc.chartData;
                    if(inc.topTrades) ext.topTrades = inc.topTrades;
                    if(inc.rektTrades) ext.rektTrades = inc.rektTrades;
                    collections.tokens.dirty = true;
                }
            });
        }
        if (data.bots) { collections.bots.data = data.bots; collections.bots.dirty = true; }
        if (data.transfers) {
            data.transfers.forEach(tx => {
                const exists = collections.transfers.data.find(x => x.id === tx.id);
                if (!exists) { collections.transfers.data.push(tx); collections.transfers.dirty = true; }
                else if (!exists.claimed && tx.claimed) { exists.claimed = true; collections.transfers.dirty = true; }
            });
        }

        // DEVOLVER EL ESTADO COMPLETO ACTUALIZADO
        res.json({ 
            success: true,
            data: {
                users: collections.users.data,
                tokens: collections.tokens.data,
                bots: collections.bots.data,
                transfers: collections.transfers.data,
                chat: [] 
            }
        });

    } catch (e) {
        console.error("Error procesando stream:", e);
        res.status(500).json({ error: "Stream error" });
    }
});

// --- INICIO SUPER RÁPIDO ---
// 1. Abrimos el puerto INMEDIATAMENTE (Vital para Railway)
app.listen(PORT, () => {
    console.log(`🚀 SERVIDOR ZOMBIE CORRIENDO EN PUERTO ${PORT}`);
    console.log(`   (Escuchando peticiones mientras carga datos...)`);
    
    // 2. Cargamos datos DESPUÉS de abrir el puerto
    initStorage().catch(err => console.error("Error en initStorage (No fatal):", err));
    
    // 3. Activamos el guardado automático AL MAXIMO (0 ms)
    setInterval(saveLoop, 0); // ULTRA-AGRESSIVE SAVE
});