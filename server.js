require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

// Increase limit for heavy scripts
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// --- 1. SERVE AUDIO FILES ---
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
app.use(express.static('public')); 

// --- 2. SERVE FRONTEND (DIST) ---
// Vite builds to 'dist' by default. We check for that.
const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
} else {
    console.warn("⚠️  Frontend build folder ('dist') not found. Render will fix this automatically if you added the 'build' script to package.json.");
}

// --- JOB STORE ---
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

// --- API ROUTES ---

app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(publicDir, filename);
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
    // Relative URL for frontend
    const fileUrl = `/${fileName}`; 

    if (fs.existsSync(filePath)) {
        return res.json({ audioUrl: fileUrl });
    }

    try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = await tts.toStream("Hello! I am your AI narrator.");
        
        const buffer = await new Promise((resolve, reject) => {
            const _buf = [];
            audioStream.on('data', c => _buf.push(c));
            audioStream.on('end', () => resolve(Buffer.concat(_buf)));
            audioStream.on('error', reject);
        });

        fs.writeFileSync(filePath, buffer);
        res.json({ audioUrl: fileUrl });
    } catch (err) {
        console.error("Preview error:", err);
        res.status(500).json({ error: "Preview failed" });
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
            // Small delay to prevent rate limiting
            await new Promise(r => setTimeout(r, 50)); 
        }

        const finalBuffer = Buffer.concat(audioBuffers);
        const fileName = `audio-${jobId}.mp3`;
        const filePath = path.join(publicDir, fileName);

        // Clean up old "audio-" files only (keep previews)
        fs.readdirSync(publicDir).forEach(file => {
            if (file.startsWith('audio-') && file.endsWith('.mp3')) {
                try { fs.unlinkSync(path.join(publicDir, file)); } catch(e){}
            }
        });

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

// --- 3. CATCH-ALL FOR REACT ROUTER ---
// This must be the LAST route.
app.get('*', (req, res) => {
    if (fs.existsSync(path.join(distDir, 'index.html'))) {
        res.sendFile(path.join(distDir, 'index.html'));
    } else {
        // Fallback if build is missing
        res.status(404).send('Frontend not built. Run npm run build.');
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));