const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Octokit } = require('octokit');
const fetch = require('node-fetch'); // <--- Esto funcionará cuando subas el package.json

const app = express();
const PORT = process.env.PORT || 3000;

// --- DATOS ---
const GITHUB_OWNER = "Gabrioff"; 
const GITHUB_REPO = "backend-memecoin"; 
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
    console.error("❌ ERROR CRÍTICO: Falta GITHUB_TOKEN.");
    process.exit(1); 
}

// Inicializar Octokit pasando fetch explícitamente
const octokit = new Octokit({ 
    auth: GITHUB_TOKEN,
    request: {
        fetch: fetch 
    },
    log: { debug: () => {}, info: () => {}, warn: console.warn, error: console.error }
});

app.use(cors({ origin: '*' }));
app.use(bodyParser.json({ limit: '50mb' }));

// --- ESTRUCTURA ---
const collections = {
    users: { path: "data/users.json", data: {}, sha: null, dirty: false },
    tokens: { path: "data/tokens.json", data: {}, sha: null, dirty: false },
    bots: { path: "data/bots.json", data: [], sha: null, dirty: false },
    transfers: { path: "data/transfers.json", data: [], sha: null, dirty: false }
};

let isSaving = false;

// --- 1. CARGA INTELIGENTE (Con Autoreparación) ---
async function initStorage() {
    console.log(`🔌 [CONECTANDO] Repo: ${GITHUB_OWNER}/${GITHUB_REPO}`);
    
    const promises = Object.keys(collections).map(async (key) => {
        const col = collections[key];
        try {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner: GITHUB_OWNER, repo: GITHUB_REPO, path: col.path,
                headers: { 'X-GitHub-Api-Version': '2022-11-28' }
            });
            col.sha = data.sha;
            
            // INTENTO DE LECTURA PROTEGIDO
            try {
                const rawContent = Buffer.from(data.content, 'base64').toString('utf-8');
                if (!rawContent || rawContent.trim() === "") throw new Error("Archivo vacío");
                col.data = JSON.parse(rawContent);
                console.log(`   ✅ CARGADO: ${key}`);
            } catch (parseError) {
                console.warn(`   ⚠️ CORRUPCIÓN DETECTADA en ${key}: ${parseError.message}`);
                console.log(`   🔧 REPARANDO ${key}... (Reiniciando archivo)`);
                col.data = (key === 'bots' || key === 'transfers') ? [] : {};
                col.dirty = true; 
            }

        } catch (error) {
            const status = error.status || (error.response ? error.response.status : null);
            if (status === 404) {
                console.log(`   🆕 NUEVO: ${col.path} no existe. Se creará.`);
                col.dirty = true;
                col.data = (key === 'bots' || key === 'transfers') ? [] : {};
            } else {
                console.error(`   ⚠️ ERROR DE CONEXIÓN ${key}: ${status} - ${error.message}`);
            }
        }
    });

    await Promise.all(promises);
    console.log("🚀 SERVIDOR OPERATIVO Y SIN ERRORES.");
}

// --- 2. GUARDADO ---
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
            console.log(`   ✅ GUARDADO OK: ${key}`);
        } catch (error) {
            console.error(`   ❌ ERROR GUARDANDO ${key}: ${error.message}`);
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
app.get('/', (req, res) => res.send(`Railway Backend Online (Auto-Repair Active)`));

app.get('/api/load', (req, res) => {
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
});

app.post('/api/stream', (req, res) => {
    res.json({ success: true });
    const { data } = req.body;
    if (!data) return;

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
                ext.conviction = inc.conviction; 
                if(inc.holders) ext.holders = inc.holders;
                if(inc.chartData) ext.chartData = inc.chartData;
                if(inc.topTrades) ext.topTrades = inc.topTrades;
                if(inc.rektTrades) ext.rektTrades = inc.rektTrades;
                collections.tokens.dirty = true;
            }
        });
    }
    if (data.bots && data.bots.length > 0) {
        collections.bots.data = data.bots;
        collections.bots.dirty = true;
    }
    if (data.transfers) {
        data.transfers.forEach(tx => {
            const exists = collections.transfers.data.find(x => x.id === tx.id);
            if (!exists) { collections.transfers.data.push(tx); collections.transfers.dirty = true; }
            else if (!exists.claimed && tx.claimed) { exists.claimed = true; collections.transfers.dirty = true; }
        });
    }
});

// Iniciamos
initStorage().catch(err => console.error("Error fatal en inicio:", err));
setInterval(saveLoop, 2000);
app.listen(PORT, () => console.log(`🚀 SERVIDOR EN PUERTO ${PORT}`));