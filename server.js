const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Octokit } = require('octokit');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; 
const GIST_FILENAME = "memecoin_tycoon_save_v1.json"; 

// --- VERIFICACIÓN DE SEGURIDAD ---
if (!GITHUB_TOKEN) {
    console.error("❌ ERROR CRÍTICO: Falta GITHUB_TOKEN en Render.");
    process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); 

// --- ESTADO ---
let memoryDb = { users: {}, tokens: {}, transfers: [], chat: [] };
let gistId = null;
let isDirty = false;

// --- INICIALIZACIÓN ---
async function initServer() {
    console.log("🔒 Verificando credenciales de GitHub...");
    try {
        // 1. Verificar quién soy (Test de Token)
        const { data: user } = await octokit.request('GET /user');
        console.log(`✅ Conectado como: ${user.login}`);

        // 2. Buscar Savegame
        console.log("🔄 Buscando archivo de guardado...");
        const gists = await octokit.request('GET /gists');
        const found = gists.data.find(g => g.files && g.files[GIST_FILENAME]);

        if (found) {
            gistId = found.id;
            console.log(`📂 Archivo encontrado (ID: ${gistId}). Descargando...`);
            const content = await octokit.request('GET /gists/{gist_id}', { gist_id: gistId });
            const body = content.data.files[GIST_FILENAME].content;
            if (body) {
                memoryDb = JSON.parse(body);
                console.log("🚀 DATOS RESTAURADOS. El servidor está listo.");
            }
        } else {
            console.log("⚠️ No hay archivo previo. Se creará uno nuevo al guardar.");
        }

    } catch (error) {
        console.error("❌ ERROR DE GITHUB:", error.message);
        console.error("👉 Asegúrate de que el Token tiene permiso de 'gist' activado.");
    }
}

// --- PERSISTENCIA ---
async function saveToGithub() {
    if (!isDirty) return;
    isDirty = false;
    
    console.log("💾 Guardando cambios en la nube...");
    const payload = JSON.stringify(memoryDb, null, 2);

    try {
        if (!gistId) {
            const res = await octokit.request('POST /gists', {
                description: 'Memecoin Tycoon DB',
                public: false,
                files: { [GIST_FILENAME]: { content: payload } }
            });
            gistId = res.data.id;
            console.log(`✅ Nuevo archivo creado: ${gistId}`);
        } else {
            await octokit.request('PATCH /gists/{gist_id}', {
                gist_id: gistId,
                files: { [GIST_FILENAME]: { content: payload } }
            });
            console.log("✅ Guardado exitoso.");
        }
    } catch (e) {
        console.error("❌ Error guardando:", e.message);
        isDirty = true; // Reintentar
    }
}

// Arrancar
initServer();
setInterval(saveToGithub, 5000); // Guardar cada 5s

// --- API ---
app.get('/', (req, res) => res.send('Memecoin Server Running'));

app.get('/api/load', (req, res) => {
    res.json({ success: true, data: memoryDb });
});

app.post('/api/stream', (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).send();

    // Fusionar datos
    if (data.users) memoryDb.users = { ...memoryDb.users, ...data.users };
    if (data.tokens) {
        Object.keys(data.tokens).forEach(k => {
            // Preservar datos existentes si el cliente manda parcial
            const existing = memoryDb.tokens[k] || {};
            memoryDb.tokens[k] = { ...existing, ...data.tokens[k] };
        });
    }
    if (data.transfers) {
        // Solo añadir transferencias nuevas
        data.transfers.forEach(tx => {
            if(!memoryDb.transfers.find(x => x.id === tx.id)) {
                memoryDb.transfers.push(tx);
            } else {
                // Actualizar status
                const ex = memoryDb.transfers.find(x => x.id === tx.id);
                if(ex) ex.claimed = tx.claimed;
            }
        });
    }

    isDirty = true;
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Puerto ${PORT}`));