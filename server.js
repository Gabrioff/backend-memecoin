const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Octokit } = require('octokit');

const app = express();
const PORT = process.env.PORT || 3000;

// --- TUS DATOS DEL REPOSITORIO ---
// Cámbialos si es necesario, pero los puse basados en tu imagen
const GITHUB_OWNER = "Gabrioff"; 
const GITHUB_REPO = "backend-memecoin";
const DB_PATH = "database.json"; // El archivo que se creará

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
    console.error("❌ ERROR: Falta GITHUB_TOKEN en Render.");
    process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// --- ESTADO EN MEMORIA ---
let memoryDb = { users: {}, tokens: {}, transfers: [], chat: [] };
let fileSha = null; // Necesario para actualizar archivos en GitHub
let isDirty = false;

// --- SISTEMA DE GUARDADO EN REPO ---

async function initStorage() {
    console.log(`🔄 Conectando con repo ${GITHUB_OWNER}/${GITHUB_REPO}...`);
    try {
        // Intentar leer el archivo database.json
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: DB_PATH,
        });

        // Si existe, descargamos y parseamos
        fileSha = data.sha; // Guardamos el SHA para poder sobrescribir después
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        memoryDb = JSON.parse(content);
        console.log("✅ BASE DE DATOS CARGADA DEL REPOSITORIO.");
        console.log(`   Tokens: ${Object.keys(memoryDb.tokens).length} | Usuarios: ${Object.keys(memoryDb.users).length}`);

    } catch (error) {
        if (error.status === 404) {
            console.log("🆕 Archivo no encontrado. Se creará 'database.json' en el primer guardado.");
        } else {
            console.error("❌ ERROR DE CONEXIÓN GITHUB:", error.status);
            console.error("👉 VERIFICA QUE TU TOKEN TENGA PERMISOS DE 'REPO' ACTIVADOS.");
        }
    }
}

async function saveToRepo() {
    if (!isDirty) return;
    
    // Backup rápido para evitar conflictos si el guardado tarda
    const contentToSave = JSON.stringify(memoryDb, null, 2); 
    const currentDirtyState = isDirty;
    isDirty = false; // Asumimos éxito para no bloquear, revertimos si falla

    console.log("💾 Guardando en Repositorio...");

    try {
        const res = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: DB_PATH,
            message: `Auto-save ${new Date().toISOString()}`, // Mensaje del commit
            content: Buffer.from(contentToSave).toString('base64'),
            sha: fileSha // Importante: pasar el SHA anterior si existe
        });

        fileSha = res.data.content.sha; // Actualizar SHA para la próxima
        console.log("✅ GUARDADO EXITOSO EN GITHUB.");
    } catch (error) {
        console.error("❌ ERROR GUARDANDO:", error.message);
        isDirty = true; // Volver a intentar
        
        // Si hay conflicto de SHA (alguien más editó), intentamos recargar
        if (error.status === 409) {
            console.log("⚠️ Conflicto de versión. Recargando SHA...");
            await initStorage(); 
        }
    }
}

// Iniciar
initStorage();

// Guardar cada 2 segundos (GitHub tiene limites, 1s es muy arriesgado, 2s es seguro)
setInterval(saveToRepo, 2000);

// --- API ---
app.get('/', (req, res) => res.send('Server OK'));

app.get('/api/load', (req, res) => {
    res.json({ success: true, data: memoryDb });
});

app.post('/api/stream', (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).send();

    // Fusión de datos
    if (data.users) memoryDb.users = { ...memoryDb.users, ...data.users };
    if (data.transfers) {
        data.transfers.forEach(tx => {
            if(!memoryDb.transfers.find(x => x.id === tx.id)) memoryDb.transfers.push(tx);
            else {
                const ex = memoryDb.transfers.find(x => x.id === tx.id);
                if(ex) ex.claimed = tx.claimed;
            }
        });
    }
    // Fusión profunda de tokens (Gráficas)
    if(data.tokens) {
        Object.keys(data.tokens).forEach(tid => {
            const incoming = data.tokens[tid];
            const existing = memoryDb.tokens[tid];
            if (!existing) {
                memoryDb.tokens[tid] = incoming;
            } else {
                // Actualizar todo menos lo que queramos proteger
                memoryDb.tokens[tid] = { ...existing, ...incoming };
                // Asegurar que las gráficas se fusionen o actualicen
                if(incoming.chartData) memoryDb.tokens[tid].chartData = incoming.chartData;
            }
        });
    }

    isDirty = true;
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Puerto ${PORT}`));