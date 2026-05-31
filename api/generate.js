const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync, exec } = require("child_process");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const PEXELS_KEY = process.env.PEXELS_API_KEY;

async function generateScript(niche, tone, today) {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY manquante sur Render");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01" },
    body: JSON.stringify({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `Aujourd'hui ${today}. Génère un script viral YouTube Shorts style Hugodecrypte sur la niche: ${niche}, ton: ${tone}.
Réponds UNIQUEMENT en JSON:
{
  "sujet": "titre accrocheur",
  "scenes": [
    {"texte": "texte narration 1-2 phrases", "mots_cles_image": "search query english pour trouver image"},
    {"texte": "texte narration 1-2 phrases", "mots_cles_image": "search query english"},
    {"texte": "texte narration 1-2 phrases", "mots_cles_image": "search query english"},
    {"texte": "texte narration 1-2 phrases", "mots_cles_image": "search query english"},
    {"texte": "texte narration 1-2 phrases", "mots_cles_image": "search query english"}
  ],
  "hashtags": ["#tag1","#tag2","#tag3","#tag4","#tag5"],
  "titre_youtube": "titre SEO max 60 chars"
}`
      }]
    })
  });
  const data = await res.json();
  const raw = data.content?.filter(b => b.type==="text").map(b => b.text).join("") || "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Pas de JSON Claude");
  return JSON.parse(match[0]);
}

async function generateVoiceover(text) {
  const res = await fetch("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM", {
    method: "POST",
    headers: { "Content-Type":"application/json","xi-api-key":ELEVENLABS_KEY },
    body: JSON.stringify({ text, model_id:"eleven_multilingual_v2", voice_settings:{ stability:0.5, similarity_boost:0.75 } })
  });
  if (!res.ok) throw new Error("ElevenLabs error: " + res.status);
  const buffer = await res.buffer();
  return buffer;
}

async function searchImage(query) {
  const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=portrait`, {
    headers: { "Authorization": PEXELS_KEY }
  });
  const data = await res.json();
  return data.photos?.[0]?.src?.large2x || data.photos?.[0]?.src?.original || null;
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", reject);
  });
}

router.post("/", async (req, res) => {
  const { niche, tone, today } = req.body;
  const jobId = Date.now().toString();
  const workDir = path.join("/tmp", jobId);
  fs.mkdirSync(workDir, { recursive: true });

  // Store job status
  global.jobs = global.jobs || {};
  global.jobs[jobId] = { status: "processing", step: "Génération du script..." };

  res.json({ job_id: jobId });

  try {
    // Step 1: Generate script
    global.jobs[jobId].step = "Génération du script...";
    const script = await generateScript(niche, tone, today);
    global.jobs[jobId].script = script;

    // Step 2: Generate full voiceover
    global.jobs[jobId].step = "Génération de la voix off...";
    const fullText = script.scenes.map(s => s.texte).join(" ");
    const audioBuffer = await generateVoiceover(fullText);
    const audioPath = path.join(workDir, "voiceover.mp3");
    fs.writeFileSync(audioPath, audioBuffer);

    // Step 3: Download images
    global.jobs[jobId].step = "Téléchargement des images...";
    const imagePaths = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const imgUrl = await searchImage(script.scenes[i].mots_cles_image);
      if (imgUrl) {
        const imgPath = path.join(workDir, `img_${i}.jpg`);
        await downloadFile(imgUrl, imgPath);
        imagePaths.push(imgPath);
      }
    }

    // Step 4: Create video with FFmpeg
    global.jobs[jobId].step = "Montage vidéo en cours...";
    const duration = imagePaths.length > 0 ? 50 / imagePaths.length : 10;
    
    // Create image list for ffmpeg
    const listPath = path.join(workDir, "images.txt");
    const listContent = imagePaths.map(p => `file '${p}'\nduration ${duration}`).join("\n");
    fs.writeFileSync(listPath, listContent);

    const outputPath = path.join(workDir, "output.mp4");

    await new Promise((resolve, reject) => {
      const cmd = `ffmpeg -f concat -safe 0 -i "${listPath}" -i "${audioPath}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.002,1.3)':d=${Math.round(duration*25)}:s=1080x1920" -c:v libx264 -c:a aac -shortest -y "${outputPath}"`;
      exec(cmd, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr));
        else resolve();
      });
    });

    // Move to public
    const publicDir = path.join(__dirname, "../public/videos");
    fs.mkdirSync(publicDir, { recursive: true });
    const finalPath = path.join(publicDir, `${jobId}.mp4`);
    fs.renameSync(outputPath, finalPath);

    global.jobs[jobId] = {
      status: "completed",
      video_url: `/videos/${jobId}.mp4`,
      script
    };

  } catch(e) {
    global.jobs[jobId] = { status: "failed", error: e.message };
  }
});

module.exports = router;
