const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Octokit } = require('octokit');

const app = express();
const PORT = process.env.PORT || 3000;

// --- DATOS GITHUB ---
const GITHUB_OWNER = "Gabrioff"; 
const GITHUB_REPO = "backend-memecoin";
const DB_PATH = "database.json"; 

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
    console.error("❌ CRÍTICO: Falta GITHUB_TOKEN.");
    process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// --- BASE DE DATOS EN MEMORIA ---
// Añadimos 'bots' para guardar su estado (balance, wins, losses)
let memoryDb = { 
    users: {}, 
    tokens: {}, 
    transfers: [], 
    chat: [],
    bots: [] 
};

let fileSha = null;
let isDirty = false;
let isSaving = false;

// --- PERSISTENCIA ---

async function initStorage() {
    console.log(`🔄 Conectando a GitHub...`);
    try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: DB_PATH,
        });

        fileSha = data.sha;
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const json = JSON.parse(content);

        memoryDb = {
            users: json.users || {},
            tokens: json.tokens || {},
            transfers: json.transfers || [],
            chat: json.chat || [],
            bots: json.bots || [] // Cargar bots guardados
        };

        console.log(`✅ DB Cargada. Bots recuperados: ${memoryDb.bots.length}`);
    } catch (error) {
        if (error.status === 404) {
            console.log("🆕 Creando nueva DB.");
            isDirty = true;
        } else {
            console.error("❌ Error GitHub:", error.status);
        }
    }
}

async function refreshSha() {
    try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: DB_PATH,
        });
        fileSha = data.sha;
        return true;
    } catch (e) { return false; }
}

async function saveToRepo() {
    if (!isDirty || isSaving) return;
    isSaving = true;

    try {
        const content = Buffer.from(JSON.stringify(memoryDb, null, 2)).toString('base64');
        const res = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: DB_PATH,
            message: `Auto-save: ${new Date().toISOString()}`,
            content: content,
            sha: fileSha
        });
        fileSha = res.data.content.sha;
        isDirty = false;
        console.log("💾 Guardado OK.");
    } catch (error) {
        console.error(`❌ Error Guardado: ${error.message}`);
        if (error.status === 409) await refreshSha();
    } finally {
        isSaving = false;
    }
}

initStorage();
setInterval(saveToRepo, 1000);

// --- API ---

app.get('/', (req, res) => res.send('Server Online v3.0 (Bots Persistentes)'));

app.get('/api/load', (req, res) => {
    res.json({ success: true, data: memoryDb });
});

app.post('/api/stream', (req, res) => {
    res.json({ success: true }); 

    const { data } = req.body;
    if (!data) return;

    let changes = false;

    // 1. Usuarios
    if (data.users) {
        Object.keys(data.users).forEach(u => {
            if (!memoryDb.users[u] || JSON.stringify(memoryDb.users[u]) !== JSON.stringify(data.users[u])) {
                memoryDb.users[u] = { ...(memoryDb.users[u] || {}), ...data.users[u] };
                changes = true;
            }
        });
    }

    // 2. Tokens (y toda su info interna: holders, chart, etc)
    if (data.tokens) {
        Object.keys(data.tokens).forEach(tid => {
            const inc = data.tokens[tid];
            const ext = memoryDb.tokens[tid];
            if (!ext) {
                memoryDb.tokens[tid] = inc;
                changes = true;
            } else {
                // Actualización inteligente
                ext.marketCap = inc.marketCap;
                ext.price = inc.price;
                ext.liquidityDepth = inc.liquidityDepth;
                ext.conviction = inc.conviction;
                
                // Guardar Holders (incluyendo bots holders)
                if(inc.holders) ext.holders = inc.holders;
                
                // Guardar Gráficas
                if (inc.chartData) ext.chartData = inc.chartData;
                
                // Guardar Listas Top/Rekt
                if (inc.topTrades) ext.topTrades = inc.topTrades;
                if (inc.rektTrades) ext.rektTrades = inc.rektTrades;
                
                changes = true;
            }
        });
    }

    // 3. Bots (NUEVO: Guardar estado de los bots)
    if (data.bots && data.bots.length > 0) {
        // Si recibimos datos de bots, actualizamos. 
        // Asumimos que el cliente tiene la versión más reciente de la simulación.
        memoryDb.bots = data.bots;
        changes = true;
    }

    // 4. Transferencias
    if (data.transfers) {
        data.transfers.forEach(tx => {
            if(!memoryDb.transfers.find(x => x.id === tx.id)) {
                memoryDb.transfers.push(tx);
                changes = true;
            } else {
                const ex = memoryDb.transfers.find(x => x.id === tx.id);
                if(ex && tx.claimed && !ex.claimed) {
                    ex.claimed = true;
                    changes = true;
                }
            }
        });
    }

    if (changes) isDirty = true;
});

app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));