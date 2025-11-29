const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Octokit } = require('octokit');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN GITHUB ---
const GITHUB_OWNER = "Gabrioff"; 
const GITHUB_REPO = "backend-memecoin";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
    console.error("❌ CRÍTICO: Falta GITHUB_TOKEN.");
    process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// --- GESTOR DE COLECCIONES (CARPETAS VIRTUALES) ---
// Cada "colección" es un archivo separado en GitHub para evitar cuellos de botella
const collections = {
    users: { 
        path: "data/users.json", 
        data: {}, 
        sha: null, 
        dirty: false 
    },
    tokens: { 
        path: "data/tokens.json", 
        data: {}, 
        sha: null, 
        dirty: false 
    },
    bots: { 
        path: "data/bots.json", 
        data: [], 
        sha: null, 
        dirty: false 
    },
    transfers: { 
        path: "data/transfers.json", 
        data: [], 
        sha: null, 
        dirty: false 
    }
};

let isSaving = false; // Bloqueo global de guardado para evitar colisiones API

// --- SISTEMA DE PERSISTENCIA MODULAR ---

// 1. Cargar todas las colecciones al inicio
async function initStorage() {
    console.log(`🔄 [INICIO] Conectando con GitHub...`);
    
    // Cargamos cada archivo en paralelo
    const promises = Object.keys(collections).map(async (key) => {
        const col = collections[key];
        try {
            console.log(`   📂 Cargando ${col.path}...`);
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                path: col.path,
            });

            col.sha = data.sha;
            const content = Buffer.from(data.content, 'base64').toString('utf-8');
            col.data = JSON.parse(content);
            console.log(`   ✅ ${key.toUpperCase()} cargado. Elementos: ${Array.isArray(col.data) ? col.data.length : Object.keys(col.data).length}`);
            
        } catch (error) {
            if (error.status === 404) {
                console.log(`   🆕 ${col.path} no existe. Se creará al guardar.`);
                col.dirty = true; // Marcar para crear
            } else {
                console.error(`   ❌ Error cargando ${col.path}:`, error.status);
            }
        }
    });

    await Promise.all(promises);
    console.log("🚀 SISTEMA DE DATOS LISTO.");
}

// 2. Guardado Inteligente (Cola Secuencial)
async function saveLoop() {
    if (isSaving) return;

    // Buscamos qué colecciones necesitan guardarse
    const dirtyKeys = Object.keys(collections).filter(k => collections[k].dirty);
    if (dirtyKeys.length === 0) return;

    isSaving = true;

    // Guardamos UNO POR UNO para no saturar la API de GitHub
    for (const key of dirtyKeys) {
        const col = collections[key];
        try {
            console.log(`💾 Guardando cambios en: ${col.path}...`);
            
            // Convertimos a JSON bonito
            const contentStr = JSON.stringify(col.data, null, 2);
            const contentEncoded = Buffer.from(contentStr).toString('base64');

            const res = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                path: col.path,
                message: `Update ${key} - ${new Date().toISOString()}`,
                content: contentEncoded,
                sha: col.sha // Importante para actualizar
            });

            col.sha = res.data.content.sha;
            col.dirty = false; // ¡Limpio!
            console.log(`   ✅ ${key} guardado correctamente.`);

        } catch (error) {
            console.error(`   ❌ Error guardando ${key}: ${error.message}`);
            // Si hay conflicto (409), intentamos refrescar el SHA para la próxima
            if (error.status === 409) {
                console.log(`   ⚠️ Conflicto SHA en ${key}. Intentando resincronizar...`);
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

// Iniciar sistema
initStorage();
setInterval(saveLoop, 2000); // Guardar cambios cada 2 segundos

// --- API ---

app.get('/', (req, res) => res.send('Game Server Multi-File v4.0 Active'));

// 1. CARGA: Unir todo para el cliente
app.get('/api/load', (req, res) => {
    // El frontend espera un solo objeto gigante, así que lo construimos al vuelo
    const combinedDb = {
        users: collections.users.data,
        tokens: collections.tokens.data,
        bots: collections.bots.data,
        transfers: collections.transfers.data,
        chat: [] // Chat efímero
    };
    res.json({ success: true, data: combinedDb });
});

// 2. STREAM: Separar los datos entrantes en sus carpetas
app.post('/api/stream', (req, res) => {
    res.json({ success: true }); // Respuesta rápida para ping bajo

    const { data } = req.body;
    if (!data) return;

    // --- PROCESAMIENTO DE USUARIOS (users.json) ---
    if (data.users) {
        let usersChanged = false;
        Object.keys(data.users).forEach(u => {
            const incomingUser = data.users[u];
            const existingUser = collections.users.data[u];

            // Fusión segura: Si el usuario ya existe, actualizamos sus campos.
            // Si no existe, lo creamos.
            if (!existingUser) {
                collections.users.data[u] = incomingUser;
                usersChanged = true;
                console.log(`👤 Nuevo usuario registrado: ${u}`);
            } else {
                // Chequeo de seguridad: Evitar sobrescribir con datos vacíos si el cliente falló
                if (incomingUser.usd !== undefined) {
                    // Detectar cambios reales para no marcar 'dirty' innecesariamente
                    if (existingUser.usd !== incomingUser.usd || 
                        JSON.stringify(existingUser.holdings) !== JSON.stringify(incomingUser.holdings)) {
                        
                        collections.users.data[u] = { ...existingUser, ...incomingUser };
                        usersChanged = true;
                    }
                }
            }
        });
        if (usersChanged) collections.users.dirty = true;
    }

    // --- PROCESAMIENTO DE TOKENS (tokens.json) ---
    if (data.tokens) {
        let tokensChanged = false;
        Object.keys(data.tokens).forEach(tid => {
            const inc = data.tokens[tid];
            const ext = collections.tokens.data[tid];

            if (!ext) {
                collections.tokens.data[tid] = inc;
                tokensChanged = true;
            } else {
                // Actualizamos solo lo necesario
                ext.marketCap = inc.marketCap;
                ext.price = inc.price;
                ext.liquidityDepth = inc.liquidityDepth;
                ext.conviction = inc.conviction;
                
                // Guardar datos pesados
                if(inc.holders) ext.holders = inc.holders;
                if(inc.chartData) ext.chartData = inc.chartData;
                if(inc.topTrades) ext.topTrades = inc.topTrades;
                if(inc.rektTrades) ext.rektTrades = inc.rektTrades;
                
                tokensChanged = true;
            }
        });
        if (tokensChanged) collections.tokens.dirty = true;
    }

    // --- PROCESAMIENTO DE BOTS (bots.json) ---
    if (data.bots && data.bots.length > 0) {
        // Solo actualizamos si realmente hay datos y difieren
        // Para simplificar, si llegan bots, asumimos que el simulador tiene la autoridad
        collections.bots.data = data.bots;
        collections.bots.dirty = true;
    }

    // --- PROCESAMIENTO DE TRANSFERENCIAS (transfers.json) ---
    if (data.transfers) {
        let txChanged = false;
        data.transfers.forEach(tx => {
            const existingTx = collections.transfers.data.find(x => x.id === tx.id);
            if (!existingTx) {
                collections.transfers.data.push(tx);
                txChanged = true;
            } else if (!existingTx.claimed && tx.claimed) {
                existingTx.claimed = true;
                txChanged = true;
            }
        });
        if (txChanged) collections.transfers.dirty = true;
    }
});

app.listen(PORT, () => console.log(`🚀 Servidor Modular corriendo en puerto ${PORT}`));