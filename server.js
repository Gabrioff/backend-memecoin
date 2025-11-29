const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Octokit } = require('octokit');

const app = express();
const PORT = process.env.PORT || 3000;

// --- TUS DATOS DEL REPOSITORIO ---
const GITHUB_OWNER = "Gabrioff"; 
const GITHUB_REPO = "backend-memecoin";
const DB_PATH = "database.json"; 

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
    console.error("❌ CRÍTICO: Falta GITHUB_TOKEN en las variables de entorno.");
    process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Aumentamos el límite para permitir gráficos grandes y muchos usuarios
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// --- ESTADO EN MEMORIA (LA VERDAD ABSOLUTA DEL JUEGO) ---
let memoryDb = { 
    users: {}, 
    tokens: {}, 
    transfers: [], 
    chat: [] 
};

let fileSha = null;     // El identificador del archivo en GitHub
let isDirty = false;    // ¿Hay cambios sin guardar?
let isSaving = false;   // ¿Estamos guardando ahora mismo?

// --- SISTEMA DE PERSISTENCIA ROBUSTO ---

// 1. Cargar datos al iniciar (SOLO UNA VEZ)
async function initStorage() {
    console.log(`🔄 [INICIO] Conectando con GitHub (${GITHUB_OWNER}/${GITHUB_REPO})...`);
    try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: DB_PATH,
        });

        fileSha = data.sha;
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const json = JSON.parse(content);

        // Fusión inicial segura: Recuperamos lo que había
        memoryDb = {
            users: json.users || {},
            tokens: json.tokens || {},
            transfers: json.transfers || [],
            chat: json.chat || []
        };

        console.log(`✅ [CARGADO] DB Restaurada. Usuarios: ${Object.keys(memoryDb.users).length} | Tokens: ${Object.keys(memoryDb.tokens).length}`);
    } catch (error) {
        if (error.status === 404) {
            console.log("🆕 [NUEVO] No existe base de datos previa. Se creará una nueva.");
            isDirty = true;
        } else {
            console.error("❌ [ERROR FATAL] No se pudo leer GitHub:", error.status);
        }
    }
}

// 2. Función para obtener el último SHA sin descargar todo el archivo (para corregir conflictos)
async function refreshSha() {
    try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: DB_PATH,
        });
        fileSha = data.sha;
        console.log("🔄 [SHA] Sincronizado hash remoto:", fileSha);
        return true;
    } catch (e) {
        console.error("⚠️ [SHA] Error obteniendo hash:", e.message);
        return false;
    }
}

// 3. El Guardián del Guardado (Evita colisiones y guarda cada 1s si es necesario)
async function saveToRepo() {
    // Si no hay cambios o ya estamos guardando, no hacemos nada
    if (!isDirty || isSaving) return;

    isSaving = true; // Bloqueamos el proceso de guardado
    const startTime = Date.now();

    try {
        const contentToSave = JSON.stringify(memoryDb, null, 2);
        const contentEncoded = Buffer.from(contentToSave).toString('base64');

        // Intentamos guardar
        const res = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: DB_PATH,
            message: `Auto-save: ${new Date().toISOString()}`,
            content: contentEncoded,
            sha: fileSha // Necesario para actualizar
        });

        // Si llegamos aquí, fue éxito
        fileSha = res.data.content.sha;
        isDirty = false; // Marcamos como "limpio"
        const duration = Date.now() - startTime;
        console.log(`💾 [GUARDADO] Éxito en ${duration}ms. SHA actualizado.`);

    } catch (error) {
        console.error(`❌ [ERROR GUARDANDO] ${error.message}`);

        // Manejo especial del error 409 (Conflicto: alguien/algo modificó el archivo remotamente)
        if (error.status === 409) {
            console.log("⚠️ [CONFLICTO] El SHA remoto cambió. Obteniendo nuevo SHA y reintentando...");
            const shaUpdated = await refreshSha();
            if (shaUpdated) {
                // No ponemos isDirty = false, para que el próximo ciclo intente guardar de nuevo con el nuevo SHA
                console.log("🔄 Listo para reintentar en el siguiente ciclo.");
            }
        }
        // Si es otro error, simplemente se reintentará en el siguiente ciclo porque isDirty sigue true
    } finally {
        isSaving = false; // Liberamos el bloqueo
    }
}

// --- CICLOS DE VIDA ---

// Iniciar carga
initStorage();

// Bucle de guardado optimizado (Cada 1000ms / 1 segundo)
// Usamos setInterval pero protegido por la variable isSaving
setInterval(saveToRepo, 1000);

// Guardado de Emergencia: Si el servidor se apaga, intenta guardar una última vez
async function emergencySave() {
    console.log("🛑 [APAGADO] Intentando guardado de emergencia...");
    if (isDirty) {
        await saveToRepo();
    }
    process.exit(0);
}
process.on('SIGTERM', emergencySave);
process.on('SIGINT', emergencySave);


// --- API DE ALTA VELOCIDAD ---

app.get('/', (req, res) => res.send('Game Server Online & Persisting v2.0'));

// Carga inicial del cliente
app.get('/api/load', (req, res) => {
    res.json({ success: true, data: memoryDb });
});

// Stream de datos (El corazón del juego)
app.post('/api/stream', (req, res) => {
    // Respondemos INMEDIATAMENTE para tener el ping bajo (30ms target)
    // Procesamos los datos asíncronamente
    res.json({ success: true }); 

    const { data } = req.body;
    if (!data) return;

    let changesDetected = false;

    // 1. Usuarios: Mezcla inteligente
    if (data.users) {
        // No sobrescribimos todo el objeto users, vamos uno por uno
        Object.keys(data.users).forEach(username => {
            // Solo actualizamos si hay cambios reales o es nuevo
            if (!memoryDb.users[username]) {
                memoryDb.users[username] = data.users[username];
                changesDetected = true;
            } else {
                // Actualizamos saldo y holdings
                // Nota: Asumimos que el cliente envía el estado más reciente de SU usuario
                memoryDb.users[username] = { ...memoryDb.users[username], ...data.users[username] };
                changesDetected = true;
            }
        });
    }

    // 2. Transferencias: Solo añadir nuevas
    if (data.transfers) {
        data.transfers.forEach(tx => {
            const exists = memoryDb.transfers.find(x => x.id === tx.id);
            if (!exists) {
                memoryDb.transfers.push(tx);
                changesDetected = true;
            } else if (exists && tx.claimed && !exists.claimed) {
                // Si se reclamó, actualizamos estado
                exists.claimed = true;
                changesDetected = true;
            }
        });
    }

    // 3. Tokens: Lo más delicado (Precios, Gráficas, MarketCap)
    if (data.tokens) {
        Object.keys(data.tokens).forEach(tid => {
            const incoming = data.tokens[tid];
            const existing = memoryDb.tokens[tid];

            if (!existing) {
                memoryDb.tokens[tid] = incoming;
                changesDetected = true;
            } else {
                // Lógica de fusión para no perder datos
                
                // Si el token entrante tiene un tradeLog más nuevo, lo usamos
                // (Opcional: podrías implementar lógica más compleja aquí)
                
                // Actualizamos campos clave
                existing.marketCap = incoming.marketCap;
                existing.price = incoming.price;
                existing.liquidityDepth = incoming.liquidityDepth;
                existing.holders = incoming.holders || existing.holders; // Prioridad al nuevo, pero fallback al viejo
                
                // Gráficas: Las gráficas son pesadas. 
                // Solo actualizamos si el cliente tiene datos (normalmente el creador o quien tradea envía updates)
                if (incoming.chartData) {
                    // Mezcla simple: confiamos en el dato entrante si existe
                    // Para perfección, el cliente debería enviar solo los nuevos puntos, 
                    // pero aquí aceptamos el objeto completo para asegurar sincronía.
                    existing.chartData = incoming.chartData;
                }
                
                if (incoming.tradeLog && incoming.tradeLog.length > 0) {
                    existing.tradeLog = incoming.tradeLog;
                }

                changesDetected = true;
            }
        });
    }

    // 4. Chat (Si lo usas en el futuro)
    if (data.chat) {
        memoryDb.chat = data.chat;
        changesDetected = true;
    }

    if (changesDetected) {
        isDirty = true; // Activa el guardado en el próximo ciclo de 1 segundo
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor Maestro corriendo en puerto ${PORT}`);
    console.log(`⏱️ Sistema de persistencia GitHub activo: Intervalo 1000ms`);
});