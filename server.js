const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Octokit } = require('octokit');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN ---
// OBLIGATORIO: Poner esto en las variables de entorno de Render
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; 
const GIST_FILENAME = "memecoin_tycoon_save_v1.json"; // Nombre único para identificar tu save

// Validación de Token
if (!GITHUB_TOKEN) {
    console.error("❌ ERROR FATAL: No se encontró GITHUB_TOKEN en las variables de entorno.");
    console.error("   El servidor funcionará en modo memoria (se borrará al reiniciar).");
}

const octokit = GITHUB_TOKEN ? new Octokit({ auth: GITHUB_TOKEN }) : null;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); // Límite alto para imágenes

// --- ESTADO DEL SERVIDOR ---
let memoryDb = {
    users: {},
    tokens: {},
    transfers: [],
    chat: []
};
let gistId = null;
let isDirty = false; // Marca si hay cambios sin guardar

// --- FUNCIONES GIST ---

// 1. Buscar si ya existe un guardado al iniciar
async function initializeStorage() {
    if (!octokit) return;
    
    console.log("🔄 Buscando datos guardados en GitHub Gists...");
    try {
        const gists = await octokit.request('GET /gists');
        const found = gists.data.find(g => g.files && g.files[GIST_FILENAME]);

        if (found) {
            gistId = found.id;
            console.log(`✅ Gist encontrado (ID: ${gistId}). Cargando datos...`);
            const content = await octokit.request('GET /gists/{gist_id}', { gist_id: gistId });
            const rawBody = content.data.files[GIST_FILENAME].content;
            if (rawBody) {
                memoryDb = JSON.parse(rawBody);
                console.log(`📦 Datos cargados: ${Object.keys(memoryDb.tokens).length} tokens, ${Object.keys(memoryDb.users).length} usuarios.`);
            }
        } else {
            console.log("✨ No se encontró guardado previo. Se creará uno nuevo al primer cambio.");
        }
    } catch (error) {
        console.error("❌ Error inicializando Gist:", error.message);
    }
}

// 2. Guardar datos en GitHub
async function persistData() {
    if (!octokit || !isDirty) return;
    
    isDirty = false; // Reset flag antes de intentar para evitar bucles si falla lento
    const payload = JSON.stringify(memoryDb);

    try {
        if (!gistId) {
            // Crear nuevo
            const res = await octokit.request('POST /gists', {
                description: 'Memecoin Tycoon Database (Do not delete)',
                public: false,
                files: { [GIST_FILENAME]: { content: payload } }
            });
            gistId = res.data.id;
            console.log(`💾 NUEVO Gist creado: ${gistId}`);
        } else {
            // Actualizar existente
            await octokit.request('PATCH /gists/{gist_id}', {
                gist_id: gistId,
                files: { [GIST_FILENAME]: { content: payload } }
            });
            console.log(`💾 Gist actualizado @ ${new Date().toLocaleTimeString()}`);
        }
    } catch (error) {
        console.error("❌ Error guardando en GitHub:", error.message);
        isDirty = true; // Reintentar luego
    }
}

// Inicializar al arrancar
initializeStorage();

// Loop de guardado automático (cada 5s para no saturar API)
setInterval(persistData, 5000);


// --- API ENDPOINTS ---

app.get('/', (req, res) => res.send(`Memecoin Server Online 🟢 | Gist ID: ${gistId || 'Pendiente'}`));

// Cargar todo el estado (Cliente -> Servidor)
app.get('/api/load', (req, res) => {
    res.json({ success: true, data: memoryDb });
});

// Recibir actualizaciones (Servidor <- Cliente)
app.post('/api/stream', (req, res) => {
    const { data } = req.body;
    
    if (!data) return res.status(400).send({ error: 'No data' });

    // Fusión inteligente de datos
    // 1. Usuarios: Sobrescribir o añadir
    if(data.users) {
        memoryDb.users = { ...memoryDb.users, ...data.users };
    }
    
    // 2. Tokens: Fusión profunda para no perder gráficas de otros
    if(data.tokens) {
        Object.keys(data.tokens).forEach(tid => {
            const incoming = data.tokens[tid];
            const existing = memoryDb.tokens[tid];

            if (!existing) {
                memoryDb.tokens[tid] = incoming; // Nuevo token
            } else {
                // Actualizar precio y stats básicos
                existing.marketCap = incoming.marketCap;
                existing.holders = incoming.holders; // Ojo: esto es simple, idealmente fusionar
                
                // Gráficas: Solo añadir velas nuevas si el cliente tiene más datos recientes
                // (Para simplificar, confiamos en que el cliente activo tiene la verdad del momento)
                if(incoming.chartData) {
                    existing.chartData = incoming.chartData;
                }
            }
        });
    }

    // 3. Transferencias: Añadir nuevas
    if(data.transfers) {
        // Evitar duplicados por ID
        data.transfers.forEach(tx => {
            if(!memoryDb.transfers.find(t => t.id === tx.id)) {
                memoryDb.transfers.push(tx);
            } else {
                // Actualizar estado (claimed)
                const existingTx = memoryDb.transfers.find(t => t.id === tx.id);
                if(existingTx) existingTx.claimed = tx.claimed;
            }
        });
    }

    isDirty = true; // Marcar para guardar en GitHub
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));