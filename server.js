const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Octokit } = require('octokit');

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ""; 
const GIST_FILENAME = "memecoin_tycoon_data.json";

let octokit = null;
if (GITHUB_TOKEN) octokit = new Octokit({ auth: GITHUB_TOKEN });

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

let memoryBuffer = null;
let lastGistId = null; 
let needsSync = false;

app.get('/', (req, res) => res.send('Server OK'));

app.post('/api/stream', (req, res) => {
    if(req.body.data) {
        memoryBuffer = req.body.data;
        needsSync = true;
    }
    res.status(200).send({ status: 'buffered' });
});

app.get('/api/load', async (req, res) => {
    if (memoryBuffer) return res.json({ data: memoryBuffer });
    if (lastGistId && octokit) {
        try {
            const gist = await octokit.request('GET /gists/{gist_id}', { gist_id: lastGistId });
            res.json({ data: gist.data.files[GIST_FILENAME].content });
        } catch (e) { res.status(500).json({ error: "Error" }); }
    } else { res.json({ data: null }); }
});

setInterval(async () => {
    if (!needsSync || !memoryBuffer || !octokit) return;
    needsSync = false;
    try {
        if (!lastGistId) {
            const res = await octokit.request('POST /gists', {
                description: 'Memecoin Save', public: false,
                files: { [GIST_FILENAME]: { content: memoryBuffer } }
            });
            lastGistId = res.data.id;
        } else {
            await octokit.request('PATCH /gists/{gist_id}', {
                gist_id: lastGistId, files: { [GIST_FILENAME]: { content: memoryBuffer } }
            });
        }
    } catch (e) { needsSync = true; }
}, 2000);

app.listen(PORT, () => console.log(`Server running on ${PORT}`));