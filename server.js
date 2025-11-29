const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Octokit } = require('octokit');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración Segura desde Variables de Entorno de Render
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ""; 
const GIST_FILENAME = "memecoin_tycoon_data.json";

// Inicializar GitHub API
let octokit = null;
if (GITHUB_TOKEN) {
    octokit = new Octokit({ auth: GITHUB_TOKEN });
}

app.use(cors()); // Permitir acceso desde cualquier web
app.use(bodyParser.json({ limit: '50mb' }));

// Memoria Temporal (Buffer)
let memoryBuffer = null;
let lastGistId = null; 
let needsSync = false;

// Endpoint de Salud
app.get('/', (req, res) => res.send('Memecoin Server OK 🚀'));

// 1. Recibir datos del juego (Rápido)
app.post('/api/stream', (req, res) => {
    const { data } = req.body;
    if(data) {
        memoryBuffer = data;
        needsSync = true;
    }
    res.status(200).send({ status: 'buffered' });
});

// 2. Enviar datos guardados
app.get('/api/load', async (req, res) => {
    if (memoryBuffer) {
        res.json({ data: memoryBuffer });
    } else if (lastGistId && octokit) {
        try {
            const gist = await octokit.request('GET /gists/{gist_id}', { gist_id: lastGistId });
            const content = gist.data.files[GIST_FILENAME].content;
            memoryBuffer = content;
            res.json({ data: content });
        } catch (e) {
            res.status(500).json({ error: "Error de carga" });
        }
    } else {
        res.json({ data: null });
    }
});

// Sincronizador (Cada 2 segundos)
setInterval(async () => {
    if (!needsSync || !memoryBuffer || !octokit) return;
    needsSync = false; 
    try {
        if (!lastGistId) {
            // Crear nuevo Gist
            const res = await octokit.request('POST /gists', {
                description: 'Memecoin Tycoon Save Data',
                public: false,
                files: { [GIST_FILENAME]: { content: memoryBuffer } }
            });
            lastGistId = res.data.id;
            console.log(`[GITHUB] Nuevo Gist ID: ${lastGistId}`);
        } else {
            // Actualizar Gist
            await octokit.request('PATCH /gists/{gist_id}', {
                gist_id: lastGistId,
                files: { [GIST_FILENAME]: { content: memoryBuffer } }
            });
            console.log(`[GITHUB] Actualizado.`);
        }
    } catch (error) {
        needsSync = true; // Reintentar luego
    }
}, 2000);

app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));