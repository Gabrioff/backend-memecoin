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

// --- FUNCIONES GIST (PERSISTENCIA) ---

// 1. BUSCAR GUARDADO AL INICIAR (La clave para que no se borre)
async function initializeStorage() {
    if (!octokit) return;
    
    console.log("🔄 Arrancando servidor... Buscando datos previos en GitHub...");
    try {
        // Listar los gists del usuario
        const gists = await octokit.request('GET /gists');
        // Buscar uno que tenga nuestro nombre de archivo
        const found = gists.data.find(g => g.files && g.files[GIST_FILENAME]);

        if (found) {
            gistId = found.id;
            console.log(`✅ ¡ARCHIVO ENCONTRADO! (ID: ${gistId}). Descargando datos...`);
            
            // Descargar el contenido
            const content = await octokit.request('GET /gists/{gist_id}', { gist_id: gistId });
            const rawBody = content.data.files[GIST_FILENAME].content;
            
            if (rawBody) {
                memoryDb = JSON.parse(rawBody);
                console.log(`📦 Datos restaurados exitosamente:`);
                console.log(`   - Tokens: ${Object.keys(memoryDb.tokens || {}).length}`);
                console.log(`   - Usuarios: ${Object.keys(memoryDb.users || {}).length}`);
            }
        } else {
            console.log("✨ No se encontró archivo previo. Se creará uno nuevo automáticamente al guardar.");
        }
    } catch (error) {
        console.error("❌ Error grave inicializando Gist:", error.message);
    }
}

// 2. GUARDAR DATOS EN GITHUB
async function persistData() {
    if (!octokit || !isDirty) return;
    
    // Copia de seguridad antes de resetear flag
    const payload = JSON.stringify(memoryDb, null, 2); // Pretty print para poder leerlo en github si quieres
    isDirty = false; 

    try {
        if (!gistId) {
            // Si no tenemos ID, CREAMOS uno nuevo
            console.log("💾 Creando archivo nuevo en GitHub...");
            const res = await octokit.request('POST /gists', {
                description: 'BASE DE DATOS JUEGO MEMECOIN (NO BORRAR)',
                public: false,
                files: { [GIST_FILENAME]: { content: payload } }
            });
            gistId = res.data.id;
            console.log(`✅ Archivo creado. ID: ${gistId}`);
        } else {
            // Si ya tenemos ID, ACTUALIZAMOS el existente
            await octokit.request('PATCH /gists/{gist_id}', {
                gist_id: gistId,
                files: { [GIST_FILENAME]: { content: payload } }
            });
            console.log(`💾 Guardado en la nube completado @ ${new Date().toLocaleTimeString()}`);
        }
    } catch (error) {
        console.error("❌ Error guardando en GitHub:", error.message);
        isDirty = true; // Volver a intentar en el próximo ciclo
    }
}

// Inicializar la búsqueda al encender el servidor
initializeStorage();

// Guardar cada 5 segundos si hubo cambios (para no saturar GitHub)
setInterval(persistData, 5000);


// --- API ENDPOINTS ---

app.get('/', (req, res) => res.send(`Memecoin Server Online 🟢 | Estado: ${gistId ? 'CONECTADO A GITHUB' : 'MEMORIA LOCAL'} | Tokens: ${Object.keys(memoryDb.tokens).length}`));

// Cargar todo el estado (Cliente -> Servidor)
app.get('/api/load', (req, res) => {
    res.json({ success: true, data: memoryDb });
});

// Recibir actualizaciones (Cliente -> Servidor)
app.post('/api/stream', (req, res) => {
    const { data } = req.body;
    
    if (!data) return res.status(400).send({ error: 'No data' });

    // Fusión de datos para no perder nada
    if(data.users) memoryDb.users = { ...memoryDb.users, ...data.users };
    if(data.transfers) {
        data.transfers.forEach(tx => {
            if(!memoryDb.transfers.find(t => t.id === tx.id)) memoryDb.transfers.push(tx);
            else {
                const ex = memoryDb.transfers.find(t => t.id === tx.id);
                if(ex) ex.claimed = tx.claimed;
            }
        });
    }
    
    // Fusión profunda de tokens para guardar gráficas
    if(data.tokens) {
        Object.keys(data.tokens).forEach(tid => {
            const incoming = data.tokens[tid];
            const existing = memoryDb.tokens[tid];

            if (!existing) {
                memoryDb.tokens[tid] = incoming;
            } else {
                // Actualizar propiedades clave
                existing.marketCap = incoming.marketCap;
                existing.holders = incoming.holders;
                existing.liquidityDepth = incoming.liquidityDepth;
                existing.tradeLog = incoming.tradeLog; // Logs de transacciones
                
                // IMPORTANTE: Guardar la gráfica
                if(incoming.chartData) {
                    existing.chartData = incoming.chartData;
                }
            }
        });
    }

    isDirty = true; // Avisar que hay que guardar en GitHub
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));