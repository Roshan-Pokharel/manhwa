require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json({ limit: '50mb' }));
app.use(cors());

// --- 1. SERVE BACKEND PUBLIC FILES (Audio Output) ---
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
app.use(express.static('public')); 

// --- 2. SERVE FRONTEND STATIC FILES (Vite Build) ---
const frontendDir = path.join(__dirname, 'build');
if (fs.existsSync(frontendDir)) {
    app.use(express.static(frontendDir));
} else {
    console.warn("⚠️  Frontend build folder ('dist') not found. Run 'npm run build' in your frontend first.");
}

// --- PREVIEW CONFIG ---
const PREVIEW_TEXT = "Hello! I am the personal assistant for the Manga Epicenter text-to-audio converter.";

// --- IN-MEMORY JOB STORE ---
const jobs = {}; 

function chunkText(text, maxLength = 2000) {
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
    const chunks = [];
    let currentChunk = "";
    for (const sentence of sentences) {
        if ((currentChunk + sentence).length > maxLength) {
            chunks.push(currentChunk.trim());
            currentChunk = "";
        }
        currentChunk += sentence + " ";
    }
    if (currentChunk.trim()) chunks.push(currentChunk.trim());
    return chunks;
}

// --- AUTOMATIC CLEANUP (Optional Fallback) ---
// This acts as a backup to delete the LAST file if no new files are created for an hour.
const cleanup = () => {
    const now = Date.now();
    const ONE_HOUR = 3600 * 1000; 

    Object.keys(jobs).forEach(id => {
        if (now - jobs[id].createdAt > ONE_HOUR) {
            const filename = `audio-${id}.mp3`;
            const filePath = path.join(publicDir, filename);

            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`Deleted expired file: ${filename}`);
            }
            delete jobs[id];
        }
    });
};
setInterval(cleanup, 15 * 60 * 1000); 

/* ROUTES */

app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(publicDir, filename);

    // Security check + File existence check
    if (filename.includes('..') || !fs.existsSync(filePath)) {
        return res.status(404).send('File not found or expired.');
    }

    res.download(filePath, filename);
});

app.post('/preview-voice', async (req, res) => {
    const { voice } = req.body;
    if (!voice) return res.status(400).json({ error: 'Voice ID required' });

    const fileName = `preview-${voice}.mp3`;
    const filePath = path.join(publicDir, fileName);
    const fileUrl = `/preview-${voice}.mp3`; 

    if (fs.existsSync(filePath)) {
        return res.json({ audioUrl: fileUrl });
    }

    try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = await tts.toStream(PREVIEW_TEXT);
        const buffer = await new Promise((resolve, reject) => {
            const _buf = [];
            audioStream.on('data', c => _buf.push(c));
            audioStream.on('end', () => resolve(Buffer.concat(_buf)));
            audioStream.on('error', reject);
        });

        fs.writeFileSync(filePath, buffer);
        res.json({ audioUrl: fileUrl });
    } catch (err) {
        console.error("Preview generation failed:", err);
        res.status(500).json({ error: "Failed to generate preview" });
    }
});

app.post('/start-generation', (req, res) => {
    const { script, voice } = req.body;
    if (!script) return res.status(400).json({ error: 'Script required' });

    const jobId = crypto.randomUUID();
    jobs[jobId] = {
        id: jobId,
        status: 'pending',
        progress: 0,
        createdAt: Date.now(),
        result: null
    };

    processAudioJob(jobId, script, voice);
    res.json({ jobId });
});

app.get('/job-status/:id', (req, res) => {
    const job = jobs[req.params.id];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

async function processAudioJob(jobId, script, voice) {
    const job = jobs[jobId];
    job.status = 'processing';
    
    try {
        const chunks = chunkText(script);
        const audioBuffers = [];
        const tts = new MsEdgeTTS();
        await tts.setMetadata(voice || 'en-US-ChristopherNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

        for (let i = 0; i < chunks.length; i++) {
            const percent = Math.round(((i) / chunks.length) * 100);
            job.progress = percent;
            
            const { audioStream } = await tts.toStream(chunks[i]);
            const chunkBuffer = await new Promise((resolve, reject) => {
                const _buf = [];
                audioStream.on('data', c => _buf.push(c));
                audioStream.on('end', () => resolve(Buffer.concat(_buf)));
                audioStream.on('error', reject);
            });

            audioBuffers.push(chunkBuffer);
            await new Promise(r => setTimeout(r, 50)); 
        }

        const finalBuffer = Buffer.concat(audioBuffers);
        const fileName = `audio-${jobId}.mp3`;
        const filePath = path.join(publicDir, fileName);
        
        // ============================================================
        // 🔴 CRITICAL CHANGE: DELETE ALL EXISTING AUDIO FILES FIRST 🔴
        // ============================================================
        try {
            const files = fs.readdirSync(publicDir);
            for (const file of files) {
                // Check if file starts with 'audio-' (to avoid deleting previews)
                if (file.startsWith('audio-') && file.endsWith('.mp3')) {
                    fs.unlinkSync(path.join(publicDir, file));
                    console.log(`Deleted previous file to save space: ${file}`);
                }
            }
        } catch (err) {
            console.error("Error clearing old files:", err);
        }
        // ============================================================

        fs.writeFileSync(filePath, finalBuffer);

        job.status = 'completed';
        job.progress = 100;
        job.result = {
            filename: fileName, 
            audioUrl: `/${fileName}`, 
            durationEstimate: `${(script.length / 15 / 60).toFixed(1)} mins`
        };

    } catch (err) {
        console.error(`Job ${jobId} failed:`, err);
        job.status = 'failed';
        job.error = err.message;
    }
}

// --- 3. CATCH-ALL ROUTE ---
app.get(/(.*)/, (req, res) => {
    if (fs.existsSync(path.join(frontendDir, 'index.html'))) {
        res.sendFile(path.join(frontendDir, 'index.html'));
    } else {
        res.status(404).send('Frontend not built or index.html missing.');
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));